import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { fail } from "../lib/core"
import { auction, terminal } from "./ownership"

/** A prepared dependency becomes invalid atomically when its transfer marker commits. */
export async function offerAvailability(
  ctx: QueryCtx,
  offerId: Id<"placeDeals">
) {
  const links = await ctx.db
    .query("placeOfferLinks")
    .withIndex("by_offer", (q) => q.eq("offerId", offerId))
    .take(65)
  let available = true
  for (const link of links) {
    const parent = await ctx.db.get(link.transferId)
    if (parent?.status === "committed")
      return { available: false, invalid: true }
    if (
      parent &&
      !terminal(parent.status) &&
      (parent.status === "settling" || auction(parent))
    )
      available = false
  }
  return { available, invalid: false }
}

/** Persisted scan progress bounds hot pixels and recovers interrupted dependency discovery. */
export async function scanOfferDependencies(
  ctx: MutationCtx,
  deal: Doc<"placeDeals">
) {
  let ordinal = deal.conflictChunk ?? 0,
    offset = deal.conflictOffset ?? 0
  let cursor = deal.conflictCursor
  // No offers can target an unowned coordinate, so an initial acquisition has no dependencies.
  if (deal.kind === "initial") ordinal = deal.chunkCount
  const cache = new Map<string, Doc<"placeDeals"> | null>()
  const parent = async (id: Id<"placeDeals">) => {
    if (!cache.has(id)) cache.set(id, await ctx.db.get(id))
    return cache.get(id)!
  }
  let budget = 256
  while (ordinal < deal.chunkCount && budget > 0) {
    const chunk = await ctx.db
      .query("placeManifests")
      .withIndex("by_deal_ordinal", (q) =>
        q.eq("dealId", deal._id).eq("ordinal", ordinal)
      )
      .unique()
    if (!chunk) fail("CONFLICT", "Missing transfer manifest.")
    while (offset < chunk.entries.length && budget > 0) {
      const entry = chunk.entries[offset]
      const base = ctx.db
        .query("placeMemberships")
        .withIndex("by_pixel_version", (q) =>
          q.eq("pixel", entry.pixel).eq("version", entry.version)
        )
      const rows = cursor ? null : await base.take(33)
      // At most one paginated scan per mutation; cold coordinates use bounded index reads.
      const page =
        rows && rows.length < 33
          ? null
          : await base.paginate({ cursor: cursor ?? null, numItems: 32 })
      const members = page?.page ?? rows!
      budget -= members.length + 1
      for (const member of members) {
        if (member.dealId === deal._id) continue
        const offer = await parent(member.dealId)
        if (!offer || offer.kind !== "offer" || terminal(offer.status)) continue
        const links = await ctx.db
          .query("placeOfferLinks")
          .withIndex("by_offer", (q) => q.eq("offerId", offer._id))
          .take(65)
        if (links.some((link) => link.transferId === deal._id)) continue
        let live = 0,
          alreadyInvalid = false
        for (const link of links) {
          const previous = await parent(link.transferId)
          if (previous?.status === "committed") {
            alreadyInvalid = true
            break
          }
          if (!previous || terminal(previous.status))
            await ctx.db.delete(link._id)
          else live++
        }
        if (alreadyInvalid) continue
        if (live >= 64)
          fail(
            "CONFLICT",
            "Too many simultaneous transfers affect this offer. Retry after pending transfers finish."
          )
        await ctx.db.insert("placeOfferLinks", {
          offerId: offer._id,
          transferId: deal._id,
        })
        budget -= links.length + 2
      }
      if (page) {
        cursor = page.isDone ? undefined : page.continueCursor
        if (page.isDone) offset++
        budget = 0
      } else offset++
    }
    if (offset >= chunk.entries.length) {
      ordinal++
      offset = 0
      cursor = undefined
    }
  }
  await ctx.db.patch(deal._id, {
    conflictChunk: ordinal,
    conflictOffset: offset,
    conflictCursor: cursor,
    conflictsReady: ordinal >= deal.chunkCount,
  })
}
