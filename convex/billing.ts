import { v } from "convex/values"
import { internalMutation, internalQuery, query } from "./_generated/server"
import { authComponent } from "./auth"
import { fail, rateLimit, requireAgent } from "./lib/core"
import { agentCredential } from "./lib/agentIdentity"
import { agentBillingAccess } from "./lib/billingAccess"

export const current = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return null
    const account = await ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .unique()
    return {
      configured:
        !!process.env.STRIPE_SECRET_KEY?.startsWith("sk_test_") &&
        !!process.env.STRIPE_PRICE_ID &&
        !!process.env.STRIPE_WEBHOOK_SECRET &&
        !!process.env.SITE_URL,
      entitlements: account?.entitlements ?? [],
      hasCustomer: !!account?.stripeCustomerId,
    }
  },
})

export const forCheckout = internalMutation({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in to manage billing.")
    await rateLimit(ctx, `checkout:${user._id}`, 5)
    let account = await ctx.db
      .query("billingAccounts")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .unique()
    if (!account) {
      const id = await ctx.db.insert("billingAccounts", {
        ownerId: user._id,
        entitlements: [],
        syncGeneration: 0,
      })
      account = (await ctx.db.get(id))!
    }
    return {
      id: account._id,
      email: user.email,
      customerId: account.stripeCustomerId,
    }
  },
})

export const attachCustomer = internalMutation({
  args: { accountId: v.id("billingAccounts"), customerId: v.string() },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId)
    if (
      !account ||
      (account.stripeCustomerId && account.stripeCustomerId !== args.customerId)
    )
      fail("CONFLICT", "Billing account already has a customer.")
    const other = await ctx.db
      .query("billingAccounts")
      .withIndex("by_customer", (q) =>
        q.eq("stripeCustomerId", args.customerId)
      )
      .unique()
    if (other && other._id !== account._id)
      fail("CONFLICT", "Customer already belongs to an account.")
    await ctx.db.patch(account._id, { stripeCustomerId: args.customerId })
  },
})

export const access = internalQuery({
  args: { token: agentCredential },
  handler: async (ctx, { token }) => {
    const { agent } = await requireAgent(ctx, token)
    return { agentId: agent._id, ...(await agentBillingAccess(ctx, agent)) }
  },
})

// Reconcile current Stripe state, and prevent a slow request from overwriting
// a newer reconciliation when events arrive concurrently or out of order.
export const beginSync = internalMutation({
  args: { customerId: v.string(), eventId: v.string() },
  handler: async (ctx, args) => {
    if (
      await ctx.db
        .query("billingEvents")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .unique()
    )
      return null
    const account = await ctx.db
      .query("billingAccounts")
      .withIndex("by_customer", (q) =>
        q.eq("stripeCustomerId", args.customerId)
      )
      .unique()
    if (!account) return null
    const generation = account.syncGeneration + 1
    await ctx.db.patch(account._id, { syncGeneration: generation })
    return { accountId: account._id, generation }
  },
})
export const finishSync = internalMutation({
  args: {
    accountId: v.id("billingAccounts"),
    generation: v.number(),
    customerId: v.string(),
    eventId: v.string(),
    entitlements: v.array(v.string()),
  },
  handler: async (ctx, args) => {
    const account = await ctx.db.get(args.accountId)
    if (
      !account ||
      account.stripeCustomerId !== args.customerId ||
      account.syncGeneration !== args.generation
    )
      return false
    if (
      await ctx.db
        .query("billingEvents")
        .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
        .unique()
    )
      return true
    await ctx.db.patch(account._id, {
      entitlements: [...new Set(args.entitlements)],
      syncedAt: Date.now(),
    })
    await ctx.db.insert("billingEvents", {
      eventId: args.eventId,
      customerId: args.customerId,
      processedAt: Date.now(),
    })
    return true
  },
})
