import { requirePlaceEnabled } from "./place/access"
import { v } from "convex/values"
import {
  internalAction,
  internalMutation,
  mutation,
  query,
} from "./_generated/server"
import { internal } from "./_generated/api"
import {
  account,
  ensureAccount,
  ensureAllocation,
  human,
  humanReceipt,
  isOperator,
  journal,
  operator,
  reallocate,
  sandboxOnly,
} from "./place/money"
import { fail, rateLimit } from "./lib/core"
import { sandboxProvider, type PaymentEvent } from "../lib/place-provider"
import { digest, stableJson } from "../lib/hash"
import { money } from "../lib/place"

export const current = query({
  args: {},
  handler: async (ctx) => {
    requirePlaceEnabled()
    const ownerId = await human(ctx)
    const funds = await account(ctx, ownerId)
    const allocations = await ctx.db
      .query("placeAllocations")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .take(128)
    const payments = await ctx.db
      .query("placePayments")
      .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
      .order("desc")
      .take(30)
    return {
      mode: "sandbox" as const,
      liveEnabled: false,
      operator: isOperator(ownerId),
      unallocated: funds?.unallocated ?? 0,
      frozen: funds?.frozen ?? false,
      shortfall: funds?.shortfall ?? 0,
      allocations,
      payments,
    }
  },
})
export const quote = query({
  args: {
    kind: v.union(v.literal("deposit"), v.literal("withdrawal")),
    amountCents: v.number(),
  },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    await human(ctx)
    sandboxOnly()
    if (args.amountCents < 100)
      fail("VALIDATION", "Sandbox funding and withdrawals start at $1.")
    return {
      ...sandboxProvider.quote(args.kind, args.amountCents),
      mode: "sandbox" as const,
    }
  },
})
export const manage = mutation({
  args: {
    operation: v.union(
      v.literal("deposit"),
      v.literal("withdrawal"),
      v.literal("allocate"),
      v.literal("return_funds"),
      v.literal("budget_manager")
    ),
    amountCents: v.optional(v.number()),
    quotedFeeCents: v.optional(v.number()),
    agentId: v.optional(v.id("agents")),
    fromAgentId: v.optional(v.id("agents")),
    enabled: v.optional(v.boolean()),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    sandboxOnly()
    const ownerId = await human(ctx)
    const { receipt, fingerprint } = await humanReceipt(
      ctx,
      ownerId,
      args.idempotencyKey,
      args
    )
    if (receipt) return receipt.result
    await rateLimit(ctx, `place:human:${ownerId}`, 30)
    const bank = await ensureAccount(ctx, ownerId)
    if (bank.frozen) fail("FORBIDDEN", "This funding account is frozen.")
    let result: {
      paymentId?: string
      allocated?: number
      enabled?: boolean
      returned?: number
    }
    const reference = `human:${ownerId}:${args.idempotencyKey}`
    if (args.operation === "deposit" || args.operation === "withdrawal") {
      const cents = money(args.amountCents ?? 0)
      if (cents < 100)
        fail("VALIDATION", "The minimum simulated funding or withdrawal is $1.")
      const quoted = sandboxProvider.quote(args.operation, cents)
      if (args.quotedFeeCents !== quoted.feeCents)
        fail("CONFLICT", "Confirm the current fee quote before submitting.")
      if (args.operation === "withdrawal") {
        if (bank.unallocated < quoted.totalCents)
          fail(
            "CONFLICT",
            "Return unreserved allocations to the wallet before withdrawing."
          )
        await ctx.db.patch(bank._id, {
          unallocated: bank.unallocated - quoted.totalCents,
        })
        await journal(
          ctx,
          `${reference}:hold`,
          "withdrawal_hold",
          [
            { account: `human:${ownerId}:pool`, cents: -quoted.totalCents },
            { account: `withdrawal:${reference}`, cents: quoted.totalCents },
          ],
          [ownerId]
        )
      }
      const paymentId = await ctx.db.insert("placePayments", {
        ownerId,
        kind: args.operation,
        amountCents: cents,
        feeCents: quoted.feeCents,
        status: "pending",
        reference,
        nextAt: Date.now(),
        attempts: 0,
      })
      await ctx.scheduler.runAfter(0, internal.placeWallet.process, {
        paymentId,
      })
      result = { paymentId }
    } else {
      if (!args.agentId) fail("VALIDATION", "An agent is required.")
      const agent = await ctx.db.get(args.agentId)
      if (!agent || agent.ownerId !== ownerId)
        fail("FORBIDDEN", "This agent belongs to another human.")
      const funds = await ensureAllocation(ctx, agent)
      if (args.operation === "budget_manager") {
        if (agent.blocked || agent.maliciousBanId || args.enabled === undefined)
          fail(
            "VALIDATION",
            "Choose an eligible agent and an explicit permission."
          )
        await ctx.db.patch(funds._id, { budgetManager: args.enabled })
        result = { enabled: args.enabled }
      } else if (args.operation === "return_funds") {
        const cents = money(args.amountCents ?? 0)
        if (cents < 1 || funds.available < cents)
          fail("CONFLICT", "Only available funds may be returned.")
        await ctx.db.patch(funds._id, { available: funds.available - cents })
        await ctx.db.patch(bank._id, {
          unallocated: money(bank.unallocated + cents),
        })
        await journal(
          ctx,
          reference,
          "return_allocation",
          [
            { account: `agent:${agent._id}:available`, cents: -cents },
            { account: `human:${ownerId}:pool`, cents },
          ],
          [ownerId]
        )
        result = { returned: cents }
      } else {
        const postings = await reallocate(
          ctx,
          ownerId,
          args.agentId,
          args.amountCents ?? 0,
          args.fromAgentId
        )
        await journal(ctx, reference, "allocate", postings, [ownerId])
        result = { allocated: args.amountCents }
      }
    }
    await ctx.db.insert("placeHumanReceipts", {
      ownerId,
      key: args.idempotencyKey,
      fingerprint,
      result,
    })
    return result
  },
})

export const process = internalAction({
  args: { paymentId: v.id("placePayments") },
  handler: async (ctx, args) => {
    const payment = await ctx.runMutation(internal.placeWallet.start, args)
    if (!payment) return
    try {
      const event = await sandboxProvider.reconcile(payment)
      await ctx.runMutation(internal.placeWallet.applyEvent, { event })
    } catch {
      await ctx.runMutation(internal.placeWallet.retry, args)
    }
  },
})
export const start = internalMutation({
  args: { paymentId: v.id("placePayments") },
  handler: async (ctx, { paymentId }) => {
    sandboxOnly()
    const payment = await ctx.db.get(paymentId)
    if (!payment || !["pending", "processing"].includes(payment.status))
      return null
    await ctx.db.patch(paymentId, {
      status: "processing",
      attempts: payment.attempts + 1,
      nextAt: Date.now() + 60_000,
    })
    return payment
  },
})
export const retry = internalMutation({
  args: { paymentId: v.id("placePayments") },
  handler: async (ctx, { paymentId }) => {
    const payment = await ctx.db.get(paymentId)
    if (!payment || payment.status !== "processing") return
    const delay = Math.min(3600_000, 1000 * 2 ** Math.min(payment.attempts, 12))
    await ctx.db.patch(paymentId, {
      status: "pending",
      nextAt: Date.now() + delay,
      error: "Provider confirmation unavailable; reconciliation will retry.",
    })
    await ctx.scheduler.runAfter(delay, internal.placeWallet.process, {
      paymentId,
    })
  },
})
export const applyEvent = internalMutation({
  args: {
    event: v.object({
      eventId: v.string(),
      reference: v.string(),
      amountCents: v.number(),
      feeCents: v.number(),
      outcome: v.union(v.literal("succeeded"), v.literal("failed")),
      mode: v.literal("sandbox"),
    }),
  },
  handler: async (ctx, { event }: { event: PaymentEvent }) => {
    sandboxOnly()
    const fingerprint = digest(stableJson(event))
    const seen = await ctx.db
      .query("placeProviderEvents")
      .withIndex("by_provider_event", (q) =>
        q.eq("provider", "sandbox").eq("eventId", event.eventId)
      )
      .unique()
    if (seen) {
      if (seen.fingerprint !== fingerprint)
        fail("CONFLICT", "Provider event changed on replay.")
      return
    }
    const payment = await ctx.db
      .query("placePayments")
      .withIndex("by_reference", (q) => q.eq("reference", event.reference))
      .unique()
    if (
      !payment ||
      payment.amountCents !== event.amountCents ||
      payment.feeCents !== event.feeCents ||
      payment.kind === "reversal"
    )
      fail("CONFLICT", "Provider event does not match a requested payment.")
    if (["succeeded", "failed"].includes(payment.status)) {
      if (payment.status !== event.outcome)
        fail("CONFLICT", "Conflicting terminal provider event.")
    } else {
      const bank = await ensureAccount(ctx, payment.ownerId)
      const total = payment.amountCents + payment.feeCents
      if (payment.kind === "deposit" && event.outcome === "succeeded") {
        await ctx.db.patch(bank._id, {
          unallocated: money(bank.unallocated + payment.amountCents),
        })
        await journal(
          ctx,
          `payment:${payment._id}`,
          "deposit",
          [
            { account: "external:sandbox", cents: -total },
            {
              account: `human:${payment.ownerId}:pool`,
              cents: payment.amountCents,
            },
            { account: "provider:funding_fees", cents: payment.feeCents },
          ],
          [payment.ownerId]
        )
      } else if (payment.kind === "withdrawal") {
        if (event.outcome === "failed")
          await ctx.db.patch(bank._id, {
            unallocated: money(bank.unallocated + total),
          })
        await journal(
          ctx,
          `payment:${payment._id}`,
          event.outcome === "failed" ? "withdrawal_refund" : "withdrawal",
          [
            { account: `withdrawal:${payment.reference}`, cents: -total },
            ...(event.outcome === "failed"
              ? [{ account: `human:${payment.ownerId}:pool`, cents: total }]
              : [
                  { account: "external:sandbox", cents: payment.amountCents },
                  { account: "provider:payout_fees", cents: payment.feeCents },
                ]),
          ],
          [payment.ownerId]
        )
      }
      await ctx.db.patch(payment._id, {
        status: event.outcome,
        eventId: event.eventId,
      })
    }
    await ctx.db.insert("placeProviderEvents", {
      provider: "sandbox",
      eventId: event.eventId,
      fingerprint,
    })
  },
})

export const reverseDeposit = mutation({
  args: { paymentId: v.id("placePayments"), idempotencyKey: v.string() },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    sandboxOnly()
    const ownerId = await operator(ctx)
    const { receipt, fingerprint } = await humanReceipt(
      ctx,
      ownerId,
      args.idempotencyKey,
      args
    )
    if (receipt) return receipt.result
    const payment = await ctx.db.get(args.paymentId)
    if (
      !payment ||
      payment.kind !== "deposit" ||
      payment.status !== "succeeded" ||
      payment.reversedCents
    )
      fail(
        "CONFLICT",
        "Only an unreversed successful sandbox deposit can be reversed."
      )
    const bank = await ensureAccount(ctx, payment.ownerId)
    await ctx.db.patch(bank._id, {
      frozen: true,
      shortfall: money(bank.shortfall + payment.amountCents),
    })
    await ctx.db.patch(payment._id, { reversedCents: payment.amountCents })
    await journal(
      ctx,
      `reversal:${payment._id}`,
      "reversal",
      [
        {
          account: `human:${payment.ownerId}:shortfall`,
          cents: -payment.amountCents,
        },
        { account: "external:sandbox", cents: payment.amountCents },
      ],
      [payment.ownerId]
    )
    await ctx.scheduler.runAfter(0, internal.placeMaintenance.frozenAccount, {
      ownerId: payment.ownerId,
    })
    const result = { frozen: true }
    await ctx.db.insert("placeHumanReceipts", {
      ownerId,
      key: args.idempotencyKey,
      fingerprint,
      result,
    })
    return result
  },
})
