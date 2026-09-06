import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { fail } from "../lib/core"
import {
  money,
  resaleFee,
  settlementCost,
  splitProceeds,
} from "../../lib/place"
import {
  account,
  allocation,
  costs,
  eligible,
  ensureAllocation,
  journal,
} from "./money"
import { announce, cancelDeal } from "./deals"
import {
  auction,
  materialize,
  ownershipReader,
  pixelRecord,
  terminal,
} from "./ownership"

export async function prepareChunk(ctx: MutationCtx, deal: Doc<"placeDeals">) {
  const chunk = await ctx.db
    .query("placeManifests")
    .withIndex("by_deal_ordinal", (q) =>
      q.eq("dealId", deal._id).eq("ordinal", deal.preparedChunks)
    )
    .unique()
  if (!chunk) fail("CONFLICT", "The immutable manifest is incomplete.")
  const reader = ownershipReader(ctx)
  for (const expected of chunk.entries) {
    let pixel = await pixelRecord(ctx, expected.pixel)
    const owner = await reader.owner(pixel)
    if (
      owner.version !== expected.version ||
      (owner.agentId ?? owner.beneficiaryId) !== expected.ownerId ||
      owner.epoch !== expected.epoch ||
      owner.banId !== expected.banId
    )
      fail(
        "CONFLICT",
        `Pixel ${expected.pixel} changed ownership after this proposal was created.`
      )
    if (pixel?.pendingDealId && pixel.pendingDealId !== deal._id) {
      const parent = await ctx.db.get(pixel.pendingDealId)
      // Every seller has approved an accepted offer. It may supersede that seller's buy-now listing.
      if (
        parent?.kind === "buy_now" &&
        parent.status === "active" &&
        deal.kind === "offer"
      )
        await cancelDeal(
          ctx,
          parent,
          "cancelled",
          "A seller accepted a competing offer."
        )
      else if (parent && !terminal(parent.status))
        fail("CONFLICT", `Pixel ${expected.pixel} is reserved by another sale.`)
      pixel = await materialize(ctx, pixel)
    }
    if (!pixel) {
      await ctx.db.insert("placePixels", {
        pixel: expected.pixel,
        epoch: 0,
        version: "unowned",
        pendingDealId: deal._id,
        ...(deal.buyerId ? { prospectiveBuyer: deal.buyerId } : {}),
      })
    } else {
      await ctx.db.patch(pixel._id, {
        pendingDealId: deal._id,
        prospectiveBuyer: deal.buyerId,
      })
    }
  }
  await ctx.db.patch(deal._id, { preparedChunks: deal.preparedChunks + 1 })
}

/** All validation precedes financial mutations; callers must not catch failures after posting. */
export async function commit(ctx: MutationCtx, deal: Doc<"placeDeals">) {
  if (
    deal.status !== "settling" ||
    deal.preparedChunks !== deal.chunkCount ||
    (deal.kind !== "initial" && !deal.conflictsReady) ||
    !deal.buyerId
  )
    fail("CONFLICT", "The transfer is not completely prepared.")
  const buyer = await eligible(ctx, deal.buyerId, true)
  if (
    (buyer.placeEpoch ?? 0) !== deal.buyerEpoch ||
    buyer.ownerId !== deal.buyerOwnerId
  )
    fail("CONFLICT", "The buyer's identity or ownership epoch changed.")
  for (const seller of deal.sellers) {
    const agent = await ctx.db.get(seller.agentId)
    if (!agent || agent.ownerId !== seller.ownerId || !seller.approved)
      fail("CONFLICT", "A seller's identity or consent changed.")
    if (deal.kind === "forfeiture") {
      const lot = deal.lotId ? await ctx.db.get(deal.lotId) : null
      if (!lot || agent.maliciousBanId !== lot.banId)
        fail("CONFLICT", "The forfeiture case is no longer valid.")
    } else if (
      agent.maliciousBanId ||
      (agent.placeEpoch ?? 0) !== seller.epoch ||
      (await account(ctx, seller.ownerId))?.frozen
    )
      fail("CONFLICT", "A seller is no longer eligible.")
    if (
      deal.kind === "transfer"
        ? seller.ownerId !== buyer.ownerId || seller.agentId === buyer._id
        : seller.ownerId === buyer.ownerId
    )
      fail(
        "FORBIDDEN",
        "Paid self-trades and cross-human free transfers are forbidden."
      )
  }
  const hold = deal.reservationId ? await ctx.db.get(deal.reservationId) : null
  const payer = await allocation(ctx, buyer._id)
  if (
    deal.kind !== "transfer" &&
    (!hold ||
      hold.status !== "held" ||
      hold.agentId !== buyer._id ||
      hold.cents !== deal.priceCents ||
      !payer ||
      payer.reserved < hold.cents)
  )
    fail("CONFLICT", "The complete payment is not reserved.")
  const fee =
    deal.kind === "initial"
      ? deal.priceCents
      : deal.kind === "transfer"
        ? 0
        : resaleFee(deal.priceCents)
  const charge =
    deal.kind === "transfer"
      ? 0
      : settlementCost(
          deal.priceCents,
          new Set(deal.sellers.map((s) => s.ownerId)).size,
          costs()
        )
  if (
    charge > fee ||
    (deal.kind !== "initial" &&
      deal.kind !== "transfer" &&
      charge * 5 > fee * 4)
  )
    fail("CONFLICT", "Settlement costs no longer meet the agreed fee floor.")
  const proceeds =
    deal.sellers.length && deal.kind !== "transfer"
      ? splitProceeds(deal.priceCents - fee, deal.sellers)
      : []
  // After this point any exception must roll back the entire mutation.
  const postings: { account: string; cents: number }[] = []
  if (hold && payer) {
    await ctx.db.patch(payer._id, { reserved: payer.reserved - hold.cents })
    await ctx.db.patch(hold._id, { status: "spent" })
    postings.push({
      account: `agent:${buyer._id}:reserved`,
      cents: -hold.cents,
    })
  }
  for (const payment of proceeds) {
    const agentId = deal.sellers.find(
      (s) => s.agentId === payment.agentId
    )!.agentId
    const seller = (await ctx.db.get(agentId))!
    const funds = await ensureAllocation(ctx, seller)
    await ctx.db.patch(funds._id, {
      available: money(funds.available + payment.cents),
    })
    postings.push({
      account: `agent:${agentId}:available`,
      cents: payment.cents,
    })
  }
  if (deal.kind !== "transfer") {
    postings.push(
      { account: `platform:${deal._id}`, cents: fee - charge },
      { account: "provider:settlement_fees", cents: charge }
    )
    await journal(ctx, `trade:${deal._id}`, "trade", postings, [
      buyer.ownerId,
      ...deal.sellers.map((s) => s.ownerId),
    ])
  }
  await ctx.db.insert("placeTrades", {
    dealId: deal._id,
    buyerId: buyer._id,
    pixelCount: deal.pixelCount,
    priceCents: deal.priceCents,
    feeCents: fee,
    kind: deal.kind,
    sellers: proceeds.map((p) => ({
      agentId: deal.sellers.find((s) => s.agentId === p.agentId)!.agentId,
      cents: p.cents,
    })),
  })
  await ctx.db.patch(deal._id, {
    status: "committed",
    committedAt: Date.now(),
    feeCents: fee,
    nextAt: Date.now(),
    cleanupChunk: 0,
  })
  await ctx.scheduler.runAfter(0, internal.placeMaintenance.cleanup, {
    dealId: deal._id,
  })
  await ctx.scheduler.runAfter(0, internal.placeMaintenance.invalidateOffers, {
    dealId: deal._id,
  })
  await announce(
    ctx,
    deal,
    "settled",
    `${deal.title}: all ${deal.pixelCount} pixels transferred together`
  )
}

export async function activate(ctx: MutationCtx, deal: Doc<"placeDeals">) {
  for (const seller of deal.sellers) {
    const current = await ctx.db.get(seller.agentId)
    if (
      !seller.approved ||
      !current ||
      current.ownerId !== seller.ownerId ||
      (deal.kind !== "forfeiture" &&
        (current.maliciousBanId || (current.placeEpoch ?? 0) !== seller.epoch))
    )
      fail("CONFLICT", "A seller's eligibility changed during preparation.")
  }
  const expiresAt = auction(deal) ? Date.now() + deal.durationMs : undefined
  await ctx.db.patch(deal._id, {
    status: "active",
    expiresAt,
    nextAt: expiresAt ?? Number.MAX_SAFE_INTEGER,
  })
  if (expiresAt)
    await ctx.scheduler.runAt(expiresAt, internal.placeMaintenance.advance, {
      dealId: deal._id,
    })
  await announce(
    ctx,
    deal,
    "listed",
    `${deal.title}: ${auction(deal) ? "auction" : "buy-now listing"} is active`
  )
}
