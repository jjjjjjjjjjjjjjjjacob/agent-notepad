import { scanOfferDependencies } from "./place/offers"
import { v, ConvexError } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { activate, commit, prepareChunk } from "./place/settlement"
import { auction, pixelRecord, terminal } from "./place/ownership"
import { beginPreparation, cancelDeal } from "./place/deals"
import { account, beginCapacityMigration, journal, sandboxOnly } from "./place/money"

export const advance = internalMutation({
  args: { dealId: v.id("placeDeals") },
  handler: async (ctx, { dealId }) => {
    sandboxOnly()
    const deal = await ctx.db.get(dealId)
    if (!deal || terminal(deal.status)) return
    if (
      ["draft", "awaiting_approval"].includes(deal.status) ||
      (deal.status === "active" && !auction(deal))
    ) {
      if (deal.nextAt <= Date.now()) await cancelDeal(ctx, deal, "expired")
      return
    }
    if (deal.status === "active" && auction(deal)) {
      if (!deal.expiresAt || Date.now() < deal.expiresAt) return
      if (!deal.buyerId) {
        await cancelDeal(ctx, deal, "expired")
        return
      }
      try {
        await beginPreparation(ctx, deal)
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error
        await cancelDeal(
          ctx,
          deal,
          "failed",
          "A participant became ineligible before settlement."
        )
      }
      return
    }
    if (!["preparing", "settling"].includes(deal.status)) return
    if (deal.nextAt <= Date.now()) {
      await cancelDeal(
        ctx,
        deal,
        "failed",
        "Preparation timed out; no ownership or sale proceeds transferred."
      )
      return
    }
    if (deal.preparedChunks < deal.chunkCount) {
      try {
        await prepareChunk(ctx, deal)
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error
        const data = error.data as { message?: string }
        await cancelDeal(
          ctx,
          deal,
          "failed",
          data.message ?? "Ownership conflict during preparation."
        )
        return
      }
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.advance, {
        dealId,
      })
      return
    }
    if (!deal.conflictsReady && deal.kind !== "initial") {
      try {
        await scanOfferDependencies(ctx, deal)
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error
        await cancelDeal(
          ctx,
          deal,
          "failed",
          "Dependency preparation was interrupted by contention; retry the proposal."
        )
        return
      }
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.advance, {
        dealId,
      })
      return
    }
    if (deal.status === "preparing") {
      try {
        await activate(ctx, deal)
      } catch (error) {
        if (!(error instanceof ConvexError)) throw error
        await cancelDeal(ctx, deal, "failed", "Seller eligibility changed.")
      }
    } else {
      // A ban invalidates prepared work immediately, before its fanout reaches this deal.
      const parties = [
        deal.buyerId,
        ...deal.sellers
          .filter(() => deal.kind !== "forfeiture")
          .map((s) => s.agentId),
      ]
      for (const id of parties) {
        const agent = id ? await ctx.db.get(id) : null
        if (
          !agent ||
          agent.maliciousBanId ||
          (agent.ownerId && (await account(ctx, agent.ownerId))?.frozen)
        ) {
          await cancelDeal(
            ctx,
            deal,
            "failed",
            "A participant is banned or its funding account is frozen."
          )
          return
        }
      }
      await commit(ctx, deal)
    }
  },
})

export const cleanup = internalMutation({
  args: { dealId: v.id("placeDeals") },
  handler: async (ctx, { dealId }) => {
    const deal = await ctx.db.get(dealId)
    if (!deal || !terminal(deal.status) || deal.cleanupChunk >= deal.chunkCount)
      return
    if (deal.status === "committed" && deal.buyerId) {
      const buyer = await ctx.db.get(deal.buyerId)
      const ban = buyer?.maliciousBanId
        ? await ctx.db.get(buyer.maliciousBanId)
        : null
      if (ban && ban.phase !== "complete") {
        await ctx.db.patch(dealId, { nextAt: Date.now() + 60_000 })
        await ctx.scheduler.runAfter(
          60_000,
          internal.placeMaintenance.cleanup,
          { dealId }
        )
        return
      }
    }
    const chunk = await ctx.db
      .query("placeManifests")
      .withIndex("by_deal_ordinal", (q) =>
        q.eq("dealId", dealId).eq("ordinal", deal.cleanupChunk)
      )
      .unique()
    if (!chunk) return
    for (const entry of chunk.entries) {
      const pixel = await pixelRecord(ctx, entry.pixel)
      if (pixel?.pendingDealId === dealId) {
        await ctx.db.patch(pixel._id, {
          ...(deal.status === "committed"
            ? {
                ownerId: deal.buyerId,
                epoch: deal.buyerEpoch ?? 0,
                version: dealId as string,
              }
            : {}),
          pendingDealId: undefined,
          prospectiveBuyer: undefined,
        })
      }
    }
    await ctx.db.patch(dealId, {
      cleanupChunk: deal.cleanupChunk + 1,
      nextAt:
        deal.cleanupChunk + 1 < deal.chunkCount || !deal.invalidationDone
          ? Date.now()
          : Number.MAX_SAFE_INTEGER,
    })
    if (deal.cleanupChunk + 1 < deal.chunkCount)
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.cleanup, {
        dealId,
      })
  },
})

export const invalidateOffers = internalMutation({
  args: { dealId: v.id("placeDeals") },
  handler: async (ctx, { dealId }) => {
    const deal = await ctx.db.get(dealId)
    if (!deal || !terminal(deal.status) || deal.invalidationDone) return
    const links = await ctx.db
      .query("placeOfferLinks")
      .withIndex("by_transfer", (q) => q.eq("transferId", dealId))
      .take(8)
    for (const link of links) {
      if (deal.status === "committed") {
        const offer = await ctx.db.get(link.offerId)
        if (offer && !terminal(offer.status))
          await cancelDeal(
            ctx,
            offer,
            "cancelled",
            "An included pixel changed ownership; reserved offer funds were released."
          )
      }
      await ctx.db.delete(link._id)
    }
    const done = links.length < 8
    await ctx.db.patch(dealId, {
      invalidationDone: done,
      nextAt:
        done && deal.cleanupChunk >= deal.chunkCount
          ? Number.MAX_SAFE_INTEGER
          : Date.now(),
    })
    if (!done)
      await ctx.scheduler.runAfter(
        0,
        internal.placeMaintenance.invalidateOffers,
        { dealId }
      )
  },
})

export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    sandboxOnly()
    // Persist progress before scheduling so old accounts cannot monopolize recovery.
    const legacy = await ctx.db.query("placeAccounts")
      .withIndex("by_capacity_next", q => q.eq("capacityVersion", undefined)).take(50)
    const migrating = await ctx.db.query("placeAccounts")
      .withIndex("by_capacity_next", q => q.eq("capacityVersion", 0).lte("capacityNextAt", Date.now())).take(50)
    for (const bank of [...legacy, ...migrating]) await beginCapacityMigration(ctx, bank)
    for (const status of [
      "draft",
      "awaiting_approval",
      "active",
      "preparing",
      "settling",
      "committed",
      "cancelled",
      "expired",
      "failed",
    ]) {
      const due = await ctx.db
        .query("placeDeals")
        .withIndex("by_status_next", (q) =>
          q.eq("status", status).lte("nextAt", Date.now())
        )
        .take(50)
      for (const deal of due) {
        if (terminal(status)) {
          if (deal.cleanupChunk < deal.chunkCount)
            await ctx.scheduler.runAfter(0, internal.placeMaintenance.cleanup, {
              dealId: deal._id,
            })
          if (!deal.invalidationDone)
            await ctx.scheduler.runAfter(
              0,
              internal.placeMaintenance.invalidateOffers,
              { dealId: deal._id }
            )
          else if (deal.cleanupChunk >= deal.chunkCount)
            await ctx.db.patch(deal._id, { nextAt: Number.MAX_SAFE_INTEGER })
        } else
          await ctx.scheduler.runAfter(0, internal.placeMaintenance.advance, {
            dealId: deal._id,
          })
      }
    }
    // Resume interrupted preparation even when the preparation deadline has not elapsed.
    for (const status of ["preparing", "settling"]) {
      const pending = await ctx.db
        .query("placeDeals")
        .withIndex("by_status_next", (q) => q.eq("status", status))
        .take(50)
      for (const deal of pending)
        await ctx.scheduler.runAfter(0, internal.placeMaintenance.advance, {
          dealId: deal._id,
        })
    }
    for (const status of ["pending", "processing"]) {
      const payments = await ctx.db
        .query("placePayments")
        .withIndex("by_status_next", (q) =>
          q.eq("status", status).lte("nextAt", Date.now())
        )
        .take(50)
      for (const payment of payments)
        await ctx.scheduler.runAfter(0, internal.placeWallet.process, {
          paymentId: payment._id,
        })
    }
    const frozen = await ctx.db
      .query("placeAccounts")
      .withIndex("by_frozen_reconciled", (q) => q.eq("frozen", true))
      .take(50)
    for (const bank of frozen) {
      await ctx.db.patch(bank._id, { reconciledAt: Date.now() })
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.frozenAccount, {
        ownerId: bank.ownerId,
      })
    }
  },
})

export const frozenAccount = internalMutation({
  args: {
    ownerId: v.string(),
    phase: v.optional(v.union(v.literal("deals"), v.literal("allocations"))),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const bank = await account(ctx, args.ownerId)
    if (!bank?.frozen) return
    if (!args.phase || args.phase === "deals") {
      const page = await ctx.db
        .query("placeParticipants")
        .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
        .paginate({ cursor: args.cursor ?? null, numItems: 50 })
      for (const party of page.page) {
        const deal = await ctx.db.get(party.dealId)
        if (
          deal &&
          !terminal(deal.status) &&
          (deal.buyerOwnerId === args.ownerId ||
            deal.sellers.some((s) => s.ownerId === args.ownerId))
        )
          await cancelDeal(
            ctx,
            deal,
            "cancelled",
            "A funding account was frozen after a deposit reversal."
          )
      }
      await ctx.scheduler.runAfter(
        0,
        internal.placeMaintenance.frozenAccount,
        page.isDone
          ? { ownerId: args.ownerId, phase: "allocations" }
          : { ...args, phase: "deals", cursor: page.continueCursor }
      )
      return
    }
    let shortfall = bank.shortfall
    const postings: { account: string; cents: number }[] = []
    const fromPool = Math.min(bank.unallocated, shortfall)
    shortfall -= fromPool
    if (fromPool)
      postings.push({ account: `human:${bank.ownerId}:pool`, cents: -fromPool })
    const page = await ctx.db
      .query("placeAllocations")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .paginate({ cursor: args.cursor ?? null, numItems: 50 })
    for (const funds of page.page) {
      const recovered = Math.min(shortfall, funds.available)
      if (!recovered) continue
      await ctx.db.patch(funds._id, { available: funds.available - recovered })
      postings.push({
        account: `agent:${funds.agentId}:available`,
        cents: -recovered,
      })
      shortfall -= recovered
    }
    if (postings.length) {
      postings.push({
        account: `human:${bank.ownerId}:shortfall`,
        cents: bank.shortfall - shortfall,
      })
      await journal(
        ctx,
        `recover:${bank._id}:${bank.shortfall}`,
        "reversal_recovery",
        postings,
        [bank.ownerId]
      )
      await ctx.db.patch(bank._id, {
        unallocated: bank.unallocated - fromPool,
        shortfall,
      })
    }
    if (!page.isDone && shortfall)
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.frozenAccount, {
        ...args,
        phase: "allocations",
        cursor: page.continueCursor,
      })
  },
})
