import { offerAvailability } from "./offers"
import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { asId, event, fail } from "../lib/core"
import type { PlaceInput } from "../../lib/place-contracts"
import {
  DEFAULT_DURATION,
  INITIAL_PIXEL_CENTS,
  minimumResale,
  nextBid,
  PREPARATION_TIMEOUT,
} from "../../lib/place"
import { digest, stableJson } from "../../lib/hash"
import { costs, eligible, release, reserve, sellerLimit } from "./money"
import {
  auction,
  getDeal,
  ownershipReader,
  pixelRecord,
  terminal,
} from "./ownership"

export async function announce(
  ctx: MutationCtx,
  deal: Doc<"placeDeals">,
  kind: string,
  title: string,
  additional: Id<"agents">[] = []
) {
  const eventId = await event(ctx, {
    kind: `place.${kind}`,
    targetId: deal._id,
    title,
    ...(deal.creatorId ? { actorId: deal.creatorId } : {}),
  })
  const targets = new Set([
    ...deal.sellers.map((s) => s.agentId),
    ...(deal.buyerId ? [deal.buyerId] : []),
    ...additional,
  ])
  for (const agentId of targets) {
    const watching = await ctx.db
      .query("watches")
      .withIndex("by_agent_target", (q) =>
        q.eq("agentId", agentId).eq("targetId", deal._id)
      )
      .unique()
    if (!watching) await ctx.db.insert("notices", { agentId, eventId })
  }
}
export async function participant(
  ctx: MutationCtx,
  dealId: Id<"placeDeals">,
  agentId: Id<"agents">,
  ownerId: string
) {
  if (
    !(await ctx.db
      .query("placeParticipants")
      .withIndex("by_deal_agent", (q) =>
        q.eq("dealId", dealId).eq("agentId", agentId)
      )
      .unique())
  )
    await ctx.db.insert("placeParticipants", { dealId, agentId, ownerId })
}
export async function cancelDeal(
  ctx: MutationCtx,
  deal: Doc<"placeDeals">,
  status = "cancelled",
  error?: string
) {
  if (terminal(deal.status)) return
  await ctx.db.patch(deal._id, {
    status,
    ...(error ? { error } : {}),
    nextAt: Date.now(),
    cleanupChunk: 0,
  })
  await release(ctx, deal.reservationId)
  await ctx.scheduler.runAfter(0, internal.placeMaintenance.cleanup, {
    dealId: deal._id,
  })
  await ctx.scheduler.runAfter(0, internal.placeMaintenance.invalidateOffers, {
    dealId: deal._id,
  })
  await announce(
    ctx,
    deal,
    status,
    `${deal.title}: ${status}${error ? ` — ${error}` : ""}`
  )
}
export async function create(
  ctx: MutationCtx,
  actor: Doc<"agents"> | null,
  input: PlaceInput<"place_create">,
  operatorOwner?: string
) {
  if (input.kind !== "forfeiture") {
    if (!actor)
      fail("FORBIDDEN", "Only agents can create ordinary market deals.")
    await eligible(ctx, actor._id)
  } else if (!operatorOwner && !actor?.platformAuctioneer)
    fail(
      "FORBIDDEN",
      "Only an authorized platform auctioneer can price forfeiture lots."
    )
  const buyerId =
    input.kind === "initial" || input.kind === "offer"
      ? actor!._id
      : input.buyerId
        ? asId(ctx, "agents", input.buyerId)
        : undefined
  if (input.kind === "transfer" && !buyerId)
    fail("VALIDATION", "A destination agent is required.")
  if (!["initial", "offer", "transfer"].includes(input.kind) && input.buyerId)
    fail("VALIDATION", "The buyer is selected by purchase or auction bidding.")
  let lotId: Id<"placeForfeitures"> | undefined
  if (input.kind === "forfeiture") {
    if (!input.lotId) fail("VALIDATION", "A forfeiture lot is required.")
    lotId = asId(ctx, "placeForfeitures", input.lotId)
    const lot = await ctx.db.get(lotId)
    const ban = lot ? await ctx.db.get(lot.banId) : null
    if (
      !lot ||
      !ban ||
      ban.phase !== "complete" ||
      lot.pixels.length !== input.pixelCount
    )
      fail(
        "CONFLICT",
        "Wait until the confirmed ban's complete inventory is available."
      )
    if (lot.dealId && !terminal((await getDeal(ctx, lot.dealId)).status))
      fail("CONFLICT", "This lot already has an auction.")
  } else if (input.lotId)
    fail("VALIDATION", "Only forfeiture auctions use a lot ID.")
  if (!["initial", "transfer"].includes(input.kind) && !input.priceCents)
    fail("VALIDATION", "Set an explicit asking price or opening bid.")
  const id = await ctx.db.insert("placeDeals", {
    kind: input.kind,
    title: input.title,
    ...(actor ? { creatorId: actor._id } : {}),
    ...(operatorOwner ? { creatorOwnerId: operatorOwner } : {}),
    status: "draft",
    pixelCount: input.pixelCount,
    appended: 0,
    chunkCount: 0,
    lastPixel: -1,
    manifestHash: digest("place-manifest-v1"),
    sellers: [],
    priceCents:
      input.kind === "initial"
        ? input.pixelCount * INITIAL_PIXEL_CENTS
        : input.kind === "transfer"
          ? 0
          : input.priceCents!,
    minimumCents: 0,
    durationMs: input.durationMs ?? DEFAULT_DURATION,
    ...(buyerId ? { buyerId } : {}),
    ...(lotId ? { lotId } : {}),
    bidCount: 0,
    nextAt: Date.now() + DEFAULT_DURATION,
    preparedChunks: 0,
    cleanupChunk: 0,
  })
  if (lotId) await ctx.db.patch(lotId, { dealId: id })
  return {
    dealId: id,
    status: "draft",
    mode: "sandbox",
    next: "Append strictly increasing pixel IDs in chunks of at most 500, then seal the manifest.",
  }
}
function creator(
  deal: Doc<"placeDeals">,
  actor: Doc<"agents"> | null,
  operatorOwner?: string
) {
  if (
    (actor && actor._id === deal.creatorId) ||
    (operatorOwner && operatorOwner === deal.creatorOwnerId)
  )
    return
  fail("FORBIDDEN", "Only this proposal's creator can change it.")
}
export async function append(
  ctx: MutationCtx,
  actor: Doc<"agents"> | null,
  input: PlaceInput<"place_append">,
  operatorOwner?: string
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  creator(deal, actor, operatorOwner)
  if (deal.status !== "draft" || deal.nextAt <= Date.now())
    fail("CONFLICT", "This draft is sealed or expired.")
  if (input.pixels.length !== Math.min(500, deal.pixelCount - deal.appended))
    fail(
      "VALIDATION",
      "Append 500 pixels per chunk, except the final remainder."
    )
  if (deal.appended + input.pixels.length > deal.pixelCount)
    fail("VALIDATION", "Manifest exceeds the declared pixel count.")
  let last = deal.lastPixel
  const reader = ownershipReader(ctx)
  const entries: Doc<"placeManifests">["entries"] = []
  const sellers = deal.sellers.map((s) => ({ ...s }))
  const lot = deal.lotId ? await ctx.db.get(deal.lotId) : null
  for (const pixel of input.pixels) {
    if (pixel <= last)
      fail(
        "VALIDATION",
        "Pixel IDs must be unique and strictly increasing across all chunks."
      )
    last = pixel
    const record = await pixelRecord(ctx, pixel)
    const owner = await reader.owner(record)
    const pending = record?.pendingDealId
      ? await reader.deal(record.pendingDealId)
      : null
    if (
      deal.kind === "offer" &&
      pending &&
      !terminal(pending.status) &&
      (auction(pending) || pending.status === "settling")
    )
      fail("CONFLICT", "An auction exclusively reserves this pixel.")
    if (deal.kind === "initial") {
      if (owner.agentId || owner.banId)
        fail("CONFLICT", `Pixel ${pixel} is already owned.`)
    } else if (lot) {
      if (
        !lot.pixels.includes(pixel) ||
        owner.banId !== lot.banId ||
        owner.beneficiaryId !== lot.agentId
      )
        fail("CONFLICT", "The pixel is not part of this forfeiture lot.")
    } else if (!owner.agentId)
      fail("CONFLICT", "Resales require currently owned pixels.")
    const sellerId = owner.agentId ?? owner.beneficiaryId
    if (sellerId) {
      const source = await reader.agent(sellerId)
      if (!source?.ownerId)
        fail("CONFLICT", "Every seller must have a funding human.")
      let share = sellers.find((s) => s.agentId === sellerId)
      if (!share) {
        if (sellers.length >= sellerLimit())
          fail(
            "VALIDATION",
            `This sandbox supports at most ${sellerLimit()} selling agents per bundle.`
          )
        share = {
          agentId: sellerId,
          ownerId: source.ownerId,
          epoch: owner.epoch,
          count: 0,
          weight: 0,
          approved: false,
        }
        sellers.push(share)
        await participant(ctx, deal._id, sellerId, source.ownerId)
      }
      if (share.epoch !== owner.epoch)
        fail("CONFLICT", "The seller's ownership epoch changed.")
      share.count++
      share.weight++
    }
    entries.push({
      pixel,
      ...(sellerId ? { ownerId: sellerId } : {}),
      epoch: owner.epoch,
      version: owner.version,
      ...(owner.banId ? { banId: owner.banId } : {}),
    })
  }
  await ctx.db.insert("placeManifests", {
    dealId: deal._id,
    ordinal: deal.chunkCount,
    entries,
  })
  for (const entry of entries)
    await ctx.db.insert("placeMemberships", {
      pixel: entry.pixel,
      dealId: deal._id,
      version: entry.version,
    })
  await ctx.db.patch(deal._id, {
    appended: deal.appended + entries.length,
    chunkCount: deal.chunkCount + 1,
    lastPixel: last,
    manifestHash: digest(`${deal.manifestHash}:${stableJson(entries)}`),
    sellers,
  })
  return {
    dealId: deal._id,
    appended: deal.appended + entries.length,
    pixelCount: deal.pixelCount,
  }
}
function hashTerms(
  deal: Doc<"placeDeals">,
  sellers: Doc<"placeDeals">["sellers"],
  priceCents: number,
  durationMs: number
) {
  return digest(
    stableJson({
      manifest: deal.manifestHash,
      kind: deal.kind,
      buyer: deal.buyerId ?? null,
      priceCents,
      durationMs,
      feeBps: 1000,
      sellers: sellers
        .map((s) => ({
          agentId: s.agentId,
          ownerId: s.ownerId,
          epoch: s.epoch,
          weight: s.weight,
        }))
        .sort((a, b) => a.agentId.localeCompare(b.agentId)),
    })
  )
}
function negotiated(
  deal: Doc<"placeDeals">,
  shares?: { agentId: string; weight: number }[]
) {
  if (
    shares &&
    (shares.length !== deal.sellers.length ||
      new Set(shares.map((s) => s.agentId)).size !== shares.length ||
      shares.some(
        (s) => !deal.sellers.some((owner) => owner.agentId === s.agentId)
      ))
  )
    fail("VALIDATION", "Shares must identify every seller exactly once.")
  return deal.sellers.map((s) => ({
    ...s,
    weight: shares?.find((w) => w.agentId === s.agentId)?.weight ?? s.weight,
    approved: deal.kind === "forfeiture",
  }))
}
export async function buyerChecks(
  ctx: MutationCtx,
  deal: Doc<"placeDeals">,
  buyerId: Id<"agents">,
  binding = false
) {
  const buyer = await eligible(ctx, buyerId, binding)
  for (const seller of deal.sellers) {
    const current = await ctx.db.get(seller.agentId)
    if (
      !current ||
      current.ownerId !== seller.ownerId ||
      (deal.kind !== "forfeiture" &&
        (current.maliciousBanId || (current.placeEpoch ?? 0) !== seller.epoch))
    )
      fail("CONFLICT", "A seller's identity or eligibility changed.")
  }
  if (deal.kind === "transfer") {
    if (
      deal.sellers.some(
        (s) => s.ownerId !== buyer.ownerId || s.agentId === buyerId
      )
    )
      fail(
        "FORBIDDEN",
        "Free transfers require different agents belonging to the same human."
      )
  } else if (deal.sellers.some((s) => s.ownerId === buyer.ownerId))
    fail(
      "FORBIDDEN",
      "Paid trades between agents of the same human are not allowed."
    )
  return buyer
}
export async function beginPreparation(
  ctx: MutationCtx,
  deal: Doc<"placeDeals">,
  activation = false
) {
  const buyer = deal.buyerId
    ? await buyerChecks(ctx, deal, deal.buyerId, !!deal.reservationId)
    : null
  await ctx.db.patch(deal._id, {
    status: activation ? "preparing" : "settling",
    preparedChunks: 0,
    conflictsReady: false,
    conflictChunk: 0,
    conflictOffset: 0,
    conflictCursor: undefined,
    nextAt: Date.now() + PREPARATION_TIMEOUT,
    ...(buyer
      ? { buyerEpoch: buyer.placeEpoch ?? 0, buyerOwnerId: buyer.ownerId }
      : {}),
  })
  await ctx.scheduler.runAfter(0, internal.placeMaintenance.advance, {
    dealId: deal._id,
  })
}
export async function seal(
  ctx: MutationCtx,
  actor: Doc<"agents"> | null,
  input: PlaceInput<"place_seal">,
  operatorOwner?: string
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  creator(deal, actor, operatorOwner)
  if (
    deal.status !== "draft" ||
    deal.nextAt <= Date.now() ||
    deal.appended !== deal.pixelCount
  )
    fail("CONFLICT", "Complete this unexpired draft before sealing it.")
  if (
    deal.kind === "offer" &&
    !(await offerAvailability(ctx, deal._id)).available
  )
    fail(
      "CONFLICT",
      "Included pixels are reserved or changed ownership; cancel this offer."
    )
  const sellers = negotiated(deal, input.shares)
  const floor = ["initial", "transfer"].includes(deal.kind)
    ? 0
    : minimumResale(new Set(sellers.map((s) => s.ownerId)).size, costs())
  if (floor === null || deal.priceCents < floor)
    fail(
      "VALIDATION",
      `Price must cover verified settlement costs${floor === null ? "." : `; the current minimum is ${floor} cents.`}`
    )
  const termsHash = hashTerms(deal, sellers, deal.priceCents, deal.durationMs)
  const updated = { ...deal, sellers, termsHash, minimumCents: floor }
  let reservationId = deal.reservationId
  if (deal.buyerId) {
    const buyer = await buyerChecks(ctx, updated, deal.buyerId)
    await participant(ctx, deal._id, buyer._id, buyer.ownerId)
    if (["initial", "offer"].includes(deal.kind))
      reservationId = await reserve(ctx, deal._id, buyer._id, deal.priceCents)
  }
  const status = deal.kind === "offer" ? "active" : "awaiting_approval"
  await ctx.db.patch(deal._id, {
    sellers,
    termsHash,
    minimumCents: floor,
    status,
    ...(reservationId ? { reservationId } : {}),
    nextAt: Date.now() + deal.durationMs,
    ...(deal.kind === "offer"
      ? { expiresAt: Date.now() + deal.durationMs }
      : {}),
  })
  if (deal.kind === "initial" || deal.kind === "forfeiture")
    await beginPreparation(
      ctx,
      { ...updated, reservationId },
      deal.kind === "forfeiture"
    )
  else
    await ctx.scheduler.runAt(
      Date.now() + deal.durationMs,
      internal.placeMaintenance.advance,
      { dealId: deal._id }
    )
  await announce(
    ctx,
    updated,
    "proposal",
    `${deal.title}: ${deal.kind === "offer" ? "funded offer" : "seller approvals requested"}`
  )
  return {
    dealId: deal._id,
    termsHash,
    status:
      deal.kind === "initial"
        ? "settling"
        : deal.kind === "forfeiture"
          ? "preparing"
          : status,
    minimumCents: floor,
  }
}
export async function changeTerms(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  input: PlaceInput<"place_terms">
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  creator(deal, actor)
  if (
    deal.status !== "awaiting_approval" ||
    deal.kind === "offer" ||
    deal.nextAt <= Date.now()
  )
    fail(
      "CONFLICT",
      "Only an unactivated seller proposal can be amended; cancel and recreate other deals."
    )
  const sellers = negotiated(deal, input.shares)
  const priceCents =
    deal.kind === "transfer" ? 0 : (input.priceCents ?? deal.priceCents)
  if (priceCents < deal.minimumCents)
    fail("VALIDATION", "Price is below the settlement-cost floor.")
  const durationMs = input.durationMs ?? deal.durationMs
  const termsHash = hashTerms(deal, sellers, priceCents, durationMs)
  await ctx.db.patch(deal._id, {
    sellers,
    priceCents,
    durationMs,
    termsHash,
  })
  return { dealId: deal._id, termsHash, approvalsReset: true }
}
export async function approve(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  input: PlaceInput<"place_approve">
) {
  await eligible(ctx, actor._id)
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  if (
    !(
      ["awaiting_approval"].includes(deal.status) ||
      (deal.kind === "offer" && deal.status === "active")
    ) ||
    deal.nextAt <= Date.now()
  )
    fail("CONFLICT", "This proposal cannot be approved.")
  if (deal.termsHash !== input.termsHash)
    fail("CONFLICT", "Read and approve the exact current terms hash.")
  if (!deal.sellers.some((s) => s.agentId === actor._id))
    fail("FORBIDDEN", "Only contributing sellers can approve these terms.")
  if (
    deal.kind === "offer" &&
    !(await offerAvailability(ctx, deal._id)).available
  )
    fail("CONFLICT", "Offer pixels are reserved or have changed ownership.")
  const sellers = deal.sellers.map((s) =>
    s.agentId === actor._id ? { ...s, approved: true } : s
  )
  await ctx.db.patch(deal._id, { sellers })
  if (sellers.every((s) => s.approved))
    await beginPreparation(
      ctx,
      { ...deal, sellers },
      ["buy_now", "auction"].includes(deal.kind)
    )
  return {
    dealId: deal._id,
    approved: true,
    allApproved: sellers.every((s) => s.approved),
  }
}
export async function buy(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  input: PlaceInput<"place_buy">
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  if (
    deal.kind !== "buy_now" ||
    deal.status !== "active" ||
    deal.termsHash !== input.termsHash
  )
    fail(
      "CONFLICT",
      "This buy-now listing is unavailable or its terms changed."
    )
  const buyer = await buyerChecks(ctx, deal, actor._id)
  const reservationId = await reserve(ctx, deal._id, actor._id, deal.priceCents)
  await participant(ctx, deal._id, actor._id, buyer.ownerId)
  await ctx.db.patch(deal._id, {
    buyerId: actor._id,
    buyerOwnerId: buyer.ownerId,
    reservationId,
  })
  await beginPreparation(ctx, {
    ...deal,
    buyerId: actor._id,
    buyerOwnerId: buyer.ownerId,
    reservationId,
  })
  return { tradeId: deal._id, status: "settling" }
}
export async function bid(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  input: PlaceInput<"place_bid">
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  if (
    !auction(deal) ||
    deal.status !== "active" ||
    !deal.expiresAt ||
    Date.now() >= deal.expiresAt
  )
    fail("CONFLICT", "The auction is closed.")
  const minimum = deal.bidCount ? nextBid(deal.priceCents) : deal.priceCents
  if (deal.buyerId && (await ctx.db.get(deal.buyerId))?.maliciousBanId)
    fail(
      "CONFLICT",
      "The highest bidder was banned; this auction must be canceled."
    )
  if (input.amountCents < minimum)
    fail("VALIDATION", `The next bid must be at least ${minimum} cents.`)
  const buyer = await buyerChecks(ctx, deal, actor._id)
  // Release and re-reserve in the same transaction, including a bidder increasing its own bid.
  await release(ctx, deal.reservationId)
  const reservationId = await reserve(
    ctx,
    deal._id,
    actor._id,
    input.amountCents
  )
  const expiresAt = Math.max(deal.expiresAt, Date.now() + 60_000)
  await ctx.db.patch(deal._id, {
    buyerId: actor._id,
    buyerOwnerId: buyer.ownerId,
    buyerEpoch: buyer.placeEpoch ?? 0,
    reservationId,
    priceCents: input.amountCents,
    bidCount: deal.bidCount + 1,
    expiresAt,
    nextAt: expiresAt,
  })
  await participant(ctx, deal._id, actor._id, buyer.ownerId)
  await ctx.db.insert("placeBids", {
    dealId: deal._id,
    agentId: actor._id,
    amountCents: input.amountCents,
  })
  await ctx.scheduler.runAt(expiresAt, internal.placeMaintenance.advance, {
    dealId: deal._id,
  })
  await announce(
    ctx,
    { ...deal, buyerId: actor._id },
    "bid",
    `${deal.title}: new highest bid of ${input.amountCents} cents`,
    deal.buyerId ? [deal.buyerId] : []
  )
  return { dealId: deal._id, amountCents: input.amountCents, expiresAt }
}
export async function cancel(
  ctx: MutationCtx,
  actor: Doc<"agents">,
  input: PlaceInput<"place_cancel">
) {
  const deal = await getDeal(ctx, asId(ctx, "placeDeals", input.dealId))
  if (terminal(deal.status)) return { dealId: deal._id, status: deal.status }
  const seller = deal.sellers.some((s) => s.agentId === actor._id)
  const buyer = deal.kind === "offer" && deal.buyerId === actor._id
  if (!seller && !buyer && deal.creatorId !== actor._id)
    fail("FORBIDDEN", "You are not a party to this deal.")
  if (
    (deal.status === "settling" && !seller) ||
    (auction(deal) && deal.bidCount > 0)
  )
    fail("CONFLICT", "This deal is binding and can no longer be canceled.")
  await cancelDeal(ctx, deal)
  return { dealId: deal._id, status: "cancelled" }
}
