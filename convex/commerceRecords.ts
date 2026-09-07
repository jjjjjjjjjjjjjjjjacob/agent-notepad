import { v } from "convex/values"
import { internalMutation, internalQuery, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { agentCredential } from "./lib/agentIdentity"
import { fail, rateLimit, requireAgent } from "./lib/core"
import {
  commerceConfigured,
  commerceCommands,
  commerceMode,
  productCatalog,
  products,
  purchaseInput,
  SERVICE_PERIOD_MS,
} from "../lib/commerce"
import { digest, stableJson } from "../lib/hash"
import { humanAgent, privateAccess, purchaseForAgent } from "./commerceAccess"

export const actorArgs = {
  token: v.optional(agentCredential),
  humanAgentId: v.optional(v.string()),
}
async function actor(
  ctx: QueryCtx,
  a: {
    token?: string | import("./lib/agentIdentity").WorkosPrincipal
    humanAgentId?: string
  }
) {
  if (a.token !== undefined)
    return (await requireAgent(ctx, a.token, "billing:write")).agent
  if (a.humanAgentId) return humanAgent(ctx, a.humanAgentId)
  fail("UNAUTHORIZED", "Authenticate as an agent or its linked manager.")
}
export function purchaseView(p: Doc<"purchases">) {
  return {
    id: p._id,
    agentId: p.agentId,
    product: p.product,
    mode: p.mode,
    purchaseMode: p.purchaseMode,
    payment: p.payment,
    amountCents: p.amountCents,
    currency: "usd",
    status: p.status,
    spaceId: p.spaceId ?? null,
    paidFrom: p.paidFrom ?? null,
    paidThrough: p.revoked ? null : (p.paidThrough ?? null),
    cancelAtPeriodEnd: p.cancelAtPeriodEnd ?? false,
    checkoutUrl: p.status === "pending" ? (p.checkoutUrl ?? null) : null,
    receiptUrl: p.receiptUrl ?? null,
    createdAt: p.createdAt,
  }
}
export const catalog = query({ args: {}, handler: () => productCatalog() })
export const enableScopes = internalMutation({
  args: { token: agentCredential, input: v.any(), requestKey: v.string() },
  handler: async (ctx, a) => {
    const { agent, key } = await requireAgent(ctx, a.token, "keys:write")
    if (!key)
      fail(
        "FORBIDDEN",
        "Request the new scopes from your credential provider; this operation upgrades local API keys only."
      )
    const parsed = commerceCommands.enable_commerce.safeParse(a.input)
    if (!parsed.success)
      fail("VALIDATION", "Choose explicit billing/private scopes for this key.")
    const fingerprint = digest(
      stableJson({
        operation: "enable_commerce",
        keyId: key._id,
        input: parsed.data,
      })
    )
    const receipt = await ctx.db
      .query("receipts")
      .withIndex("by_agent_key", (q) =>
        q.eq("agentId", agent._id).eq("key", a.requestKey)
      )
      .unique()
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        fail("CONFLICT", "This key belongs to another request.")
      return receipt.result
    }
    await rateLimit(ctx, `enable-commerce:${agent._id}`, 20, 3_600_000)
    const scopes = [...new Set([...key.scopes, ...parsed.data.scopes])]
    await ctx.db.patch(key._id, { scopes })
    await ctx.db.insert("receipts", {
      agentId: agent._id,
      key: a.requestKey,
      fingerprint,
      result: { scopes },
    })
    return { scopes }
  },
})
export const prepare = internalMutation({
  args: { ...actorArgs, input: v.any(), requestKey: v.string() },
  handler: async (ctx, a) => {
    if (!commerceConfigured())
      fail("NOT_CONFIGURED", "Stripe payments are not configured.")
    const agent = await actor(ctx, a)
    if (!a.requestKey.trim() || a.requestKey.length > 128)
      fail("VALIDATION", "Supply an idempotency key of 1–128 characters.")
    const parsed = purchaseInput.safeParse(a.input)
    if (!parsed.success)
      fail("VALIDATION", parsed.error.issues.map((i) => i.message).join("; "))
    const input = parsed.data
    if (input.payment === "link_token" && !process.env.STRIPE_AGENT_PROFILE_ID)
      fail(
        "NOT_CONFIGURED",
        "Link agent payments need STRIPE_AGENT_PROFILE_ID."
      )
    const fingerprint = digest(stableJson(input))
    const existing = await ctx.db
      .query("purchases")
      .withIndex("by_request", (q) =>
        q.eq("agentId", agent._id).eq("requestKey", a.requestKey)
      )
      .unique()
    if (existing) {
      if (
        existing.fingerprint !== fingerprint ||
        existing.mode !== commerceMode()
      )
        fail("CONFLICT", "This key belongs to another purchase.")
      return {
        purchase: existing,
        account: (await ctx.db.get(existing.accountId))!,
      }
    }
    await rateLimit(ctx, `checkout:${agent._id}`, 5, 60_000)
    let spaceId: Doc<"privateSpaces">["_id"] | undefined
    if (input.spaceId) {
      const { space } = await privateAccess(ctx, agent, input.spaceId, "owner")
      if (
        space.kind !== products[input.product].kind ||
        space.mode !== commerceMode()
      )
        fail("VALIDATION", "The product must match this space.")
      // At most one checkout/renewal may be in progress per space. A pending
      // Stripe subscription must be resolved before starting another payment.
      const related = await ctx.db
        .query("purchases")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
        .order("desc")
        .take(100)
      if (
        related.some(
          (p) =>
            p.status === "pending" ||
            (p.subscriptionId &&
              !["canceled", "incomplete_expired"].includes(p.status))
        )
      )
        fail(
          "CONFLICT",
          "Resolve or cancel this space's existing subscription or checkout first."
        )
      if (
        related.filter((p) => !p.revoked && (p.paidThrough ?? 0) > Date.now())
          .length >= 12
      )
        fail("VALIDATION", "This space already has a year of prepaid service.")
      spaceId = space._id
    }
    let account = await ctx.db
      .query("commerceAccounts")
      .withIndex("by_agent_mode", (q) =>
        q.eq("agentId", agent._id).eq("mode", commerceMode())
      )
      .unique()
    if (!account) {
      const id = await ctx.db.insert("commerceAccounts", {
        agentId: agent._id,
        mode: commerceMode(),
      })
      account = (await ctx.db.get(id))!
    }
    const id = await ctx.db.insert("purchases", {
      agentId: agent._id,
      accountId: account._id,
      mode: commerceMode(),
      product: input.product,
      purchaseMode: input.mode,
      payment: input.payment,
      amountCents: input.amountCents ?? products[input.product].cents,
      name: input.name ?? products[input.product].name,
      ...(spaceId ? { spaceId } : {}),
      requestKey: a.requestKey,
      fingerprint,
      createdAt: Date.now(),
      status: "pending",
      syncGeneration: 0,
      nextSyncAt: Date.now() + 300_000,
    })
    return { purchase: (await ctx.db.get(id))!, account }
  },
})
export const authorize = internalMutation({
  args: { ...actorArgs, purchaseId: v.string() },
  handler: async (ctx, a) => {
    const agent = await actor(ctx, a)
    await rateLimit(ctx, `payment-action:${agent._id}`, 30)
    const purchase = await purchaseForAgent(ctx, agent._id, a.purchaseId)
    if (purchase.mode !== commerceMode())
      fail(
        "CONFLICT",
        "Use the payment environment in which this purchase was created."
      )
    return purchase
  },
})
export const bindCustomer = internalMutation({
  args: { accountId: v.id("commerceAccounts"), customerId: v.string() },
  handler: async (ctx, a) => {
    const account = await ctx.db.get(a.accountId)
    const other = await ctx.db
      .query("commerceAccounts")
      .withIndex("by_customer", (q) => q.eq("stripeCustomerId", a.customerId))
      .unique()
    if (
      !account ||
      (account.stripeCustomerId && account.stripeCustomerId !== a.customerId) ||
      (other && other._id !== account._id)
    )
      fail("CONFLICT", "Customer binding does not match.")
    await ctx.db.patch(account._id, { stripeCustomerId: a.customerId })
  },
})
export const bindPayment = internalMutation({
  args: {
    purchaseId: v.id("purchases"),
    customerId: v.string(),
    checkoutId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.purchaseId)
    const account = p && (await ctx.db.get(p.accountId))
    if (
      !p ||
      account?.stripeCustomerId !== a.customerId ||
      (p.checkoutId && a.checkoutId && p.checkoutId !== a.checkoutId) ||
      (p.paymentIntentId &&
        a.paymentIntentId &&
        p.paymentIntentId !== a.paymentIntentId)
    )
      fail("CONFLICT", "Payment binding does not match.")
    const { purchaseId, ...patch } = a
    await ctx.db.patch(purchaseId, patch)
  },
})
export const reserveToken = internalMutation({
  args: { ...actorArgs, purchaseId: v.string(), tokenHash: v.string() },
  handler: async (ctx, a) => {
    const p = await purchaseForAgent(
      ctx,
      (await actor(ctx, a))._id,
      a.purchaseId
    )
    if (
      p.mode !== commerceMode() ||
      p.payment !== "link_token" ||
      p.purchaseMode !== "one_time"
    )
      fail("VALIDATION", "This purchase does not accept a Link token.")
    if (p.tokenHash && p.tokenHash !== a.tokenHash)
      fail(
        "CONFLICT",
        "Retry with the same payment credential, or create a new purchase after the failed request is reconciled."
      )
    if (!p.tokenHash) await ctx.db.patch(p._id, { tokenHash: a.tokenHash })
    return p
  },
})
export const find = internalQuery({
  args: {
    purchaseId: v.optional(v.string()),
    checkoutId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    if (a.purchaseId) {
      const id = ctx.db.normalizeId("purchases", a.purchaseId)
      return id ? ctx.db.get(id) : null
    }
    if (a.checkoutId)
      return ctx.db
        .query("purchases")
        .withIndex("by_checkout", (q) => q.eq("checkoutId", a.checkoutId))
        .unique()
    if (a.subscriptionId)
      return ctx.db
        .query("purchases")
        .withIndex("by_subscription", (q) =>
          q.eq("subscriptionId", a.subscriptionId)
        )
        .unique()
    if (a.paymentIntentId)
      return ctx.db
        .query("purchases")
        .withIndex("by_payment", (q) =>
          q.eq("paymentIntentId", a.paymentIntentId)
        )
        .unique()
    return null
  },
})
export const beginSync = internalMutation({
  args: { purchaseId: v.id("purchases"), eventId: v.optional(v.string()) },
  handler: async (ctx, a) => {
    if (
      a.eventId &&
      (await ctx.db
        .query("commerceEvents")
        .withIndex("by_event", (q) => q.eq("eventId", a.eventId!))
        .unique())
    )
      return null
    const p = await ctx.db.get(a.purchaseId)
    if (!p) return null
    const generation = p.syncGeneration + 1
    await ctx.db.patch(p._id, {
      syncGeneration: generation,
      nextSyncAt: Date.now() + 300_000,
    })
    const account = await ctx.db.get(p.accountId)
    return { purchase: p, generation, customerId: account?.stripeCustomerId }
  },
})
export const finishSync = internalMutation({
  args: {
    purchaseId: v.id("purchases"),
    generation: v.number(),
    eventId: v.optional(v.string()),
    status: v.string(),
    paid: v.boolean(),
    revoked: v.boolean(),
    paidFrom: v.optional(v.number()),
    paidThrough: v.optional(v.number()),
    subscriptionId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    receiptUrl: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const p = await ctx.db.get(a.purchaseId)
    if (!p || p.syncGeneration !== a.generation) return false
    if (
      p.subscriptionId &&
      a.subscriptionId &&
      p.subscriptionId !== a.subscriptionId
    )
      fail("CONFLICT", "Subscription changed unexpectedly.")
    let spaceId = p.spaceId
    let paidFrom = p.paidFrom
    let paidThrough = p.paidThrough
    if (a.paid && !a.revoked) {
      if (!spaceId && products[p.product].kind) {
        spaceId = await ctx.db.insert("privateSpaces", {
          ownerAgentId: p.agentId,
          name: p.name,
          kind: products[p.product].kind!,
          mode: p.mode,
          channels: ["general"],
          bytes: 0,
          entries: 0,
          revisionCount: 0,
          updatedAt: Date.now(),
        })
        await ctx.db.insert("privateMembers", {
          spaceId,
          agentId: p.agentId,
          role: "owner",
        })
      }
      if (p.purchaseMode === "one_time" && !paidThrough) {
        const existing = spaceId
          ? await ctx.db
              .query("purchases")
              .withIndex("by_space_period", (q) =>
                q.eq("spaceId", spaceId).gt("paidThrough", Date.now())
              )
              .take(25)
          : []
        paidFrom = Math.max(
          Date.now(),
          ...existing.filter((x) => !x.revoked).map((x) => x.paidThrough!)
        )
        paidThrough = paidFrom + SERVICE_PERIOD_MS
      } else if (p.purchaseMode === "subscription") {
        if (!a.paidFrom || !a.paidThrough || a.paidThrough <= a.paidFrom)
          fail("VALIDATION", "Paid subscription has no valid service period.")
        paidFrom = Math.min(paidFrom ?? a.paidFrom, a.paidFrom)
        paidThrough = Math.max(paidThrough ?? 0, a.paidThrough)
      }
    }
    await ctx.db.patch(p._id, {
      status: a.status,
      revoked: a.revoked,
      ...(a.paid && a.receiptUrl ? { receiptUrl: a.receiptUrl } : {}),
      ...(a.subscriptionId ? { subscriptionId: a.subscriptionId } : {}),
      ...(a.paymentIntentId ? { paymentIntentId: a.paymentIntentId } : {}),
      ...(a.cancelAtPeriodEnd !== undefined
        ? { cancelAtPeriodEnd: a.cancelAtPeriodEnd }
        : {}),
      ...(spaceId ? { spaceId } : {}),
      ...(paidFrom !== undefined ? { paidFrom } : {}),
      ...(paidThrough !== undefined ? { paidThrough } : {}),
      syncedAt: Date.now(),
      nextSyncAt:
        Date.now() +
        (p.purchaseMode === "subscription" ? 3_600_000 : 86_400_000),
    })
    if (a.eventId)
      await ctx.db.insert("commerceEvents", {
        eventId: a.eventId,
        purchaseId: p._id,
        processedAt: Date.now(),
      })
    return true
  },
})
export const read = internalQuery({
  args: {
    ...actorArgs,
    purchaseId: v.optional(v.string()),
    cursor: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, a) => {
    const agent = await actor(ctx, a)
    if (a.purchaseId)
      return purchaseView(await purchaseForAgent(ctx, agent._id, a.purchaseId))
    const page = await ctx.db
      .query("purchases")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .order("desc")
      .paginate({
        cursor: a.cursor ?? null,
        numItems: Math.max(1, Math.min(a.limit ?? 25, 50)),
      })
    return {
      items: page.page.map(purchaseView),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const humanPurchases = query({
  args: { agentId: v.string() },
  handler: async (ctx, a) => {
    const agent = await humanAgent(ctx, a.agentId)
    return (
      await ctx.db
        .query("purchases")
        .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
        .order("desc")
        .take(50)
    ).map(purchaseView)
  },
})
export const due = internalMutation({
  args: {},
  handler: async (ctx) => {
    if (!commerceConfigured()) return []
    const rows = await ctx.db
      .query("purchases")
      .withIndex("by_due", (q) => q.lte("nextSyncAt", Date.now()))
      .take(20)
    for (const p of rows)
      await ctx.db.patch(p._id, { nextSyncAt: Date.now() + 86_400_000 })
    return rows.filter((p) => p.mode === commerceMode()).map((p) => p._id)
  },
})
