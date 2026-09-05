"use node"
import Stripe from "stripe"
import { v } from "convex/values"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { fail } from "./lib/core"

function client() {
  const secret = process.env.STRIPE_SECRET_KEY
  // This integration is a test-mode prototype. Live billing is a separate rollout.
  if (!secret?.startsWith("sk_test_"))
    fail(
      "NOT_CONFIGURED",
      "Configure a Stripe test secret key for the billing prototype."
    )
  return new Stripe(secret, { maxNetworkRetries: 2, timeout: 15_000 })
}
function returnUrl() {
  if (!process.env.SITE_URL)
    fail("NOT_CONFIGURED", "Set SITE_URL before configuring billing.")
  return new URL("/account", process.env.SITE_URL).href
}

export const checkout = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const stripe = client()
    if (!process.env.STRIPE_PRICE_ID)
      fail("NOT_CONFIGURED", "Configure a Stripe test subscription price.")
    const account = await ctx.runMutation(internal.billing.forCheckout, {})
    let customerId = account.customerId
    if (!customerId) {
      const customer = await stripe.customers.create(
        { email: account.email, metadata: { billingAccountId: account.id } },
        { idempotencyKey: `account:${account.id}` }
      )
      customerId = customer.id
      await ctx.runMutation(internal.billing.attachCustomer, {
        accountId: account.id,
        customerId,
      })
    }
    for await (const subscription of stripe.subscriptions.list({
      customer: customerId,
      status: "all",
      limit: 100,
    })) {
      if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
        const portal = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: returnUrl(),
        })
        return { url: portal.url }
      }
    }
    const session = await stripe.checkout.sessions.create(
      {
        customer: customerId,
        mode: "subscription",
        line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
        client_reference_id: account.id,
        success_url: `${returnUrl()}?billing=success`,
        cancel_url: returnUrl(),
      },
      {
        idempotencyKey: `checkout:${account.id}:${Math.floor(Date.now() / 1_800_000)}`,
      }
    )
    if (!session.url) fail("INTERNAL", "Checkout did not return a URL.")
    return { url: session.url }
  },
})

export const portal = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    const account = await ctx.runMutation(internal.billing.forCheckout, {})
    if (!account.customerId)
      fail("NOT_FOUND", "This account has no billing customer yet.")
    const session = await client().billingPortal.sessions.create({
      customer: account.customerId,
      return_url: returnUrl(),
    })
    return { url: session.url }
  },
})

export const webhook = internalAction({
  args: { body: v.string(), signature: v.string() },
  handler: async (ctx, { body, signature }): Promise<{ received: true }> => {
    const stripe = client()
    if (!process.env.STRIPE_WEBHOOK_SECRET)
      fail("NOT_CONFIGURED", "Stripe webhook is not configured.")
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        body,
        signature,
        process.env.STRIPE_WEBHOOK_SECRET
      )
    } catch {
      fail("UNAUTHORIZED", "Invalid Stripe webhook signature.")
    }
    if (event.livemode)
      fail("FORBIDDEN", "This prototype accepts test events only.")
    const supported = [
      "entitlements.active_entitlement_summary.updated",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]
    if (!supported.includes(event.type)) return { received: true }
    const object = event.data.object as { customer?: string | { id: string } }
    const customerId =
      typeof object.customer === "string"
        ? object.customer
        : object.customer?.id
    if (!customerId) fail("VALIDATION", "Stripe event is missing its customer.")
    const sync = await ctx.runMutation(internal.billing.beginSync, {
      customerId,
      eventId: event.id,
    })
    if (!sync) return { received: true }
    const entitlements: string[] = []
    for await (const entitlement of stripe.entitlements.activeEntitlements.list(
      { customer: customerId, limit: 100 }
    ))
      entitlements.push(entitlement.lookup_key)
    await ctx.runMutation(internal.billing.finishSync, {
      ...sync,
      customerId,
      eventId: event.id,
      entitlements,
    })
    return { received: true }
  },
})
