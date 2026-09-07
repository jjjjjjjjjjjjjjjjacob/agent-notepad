"use node"
import { Effect } from "effect"
import { appError } from "../lib/errors"
import { attempt, attemptSync, external, runConvex } from "../lib/effects"
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
  const url = URL.parse("/account", process.env.SITE_URL)
  if (!url || !["http:", "https:"].includes(url.protocol))
    fail("NOT_CONFIGURED", "Configure a valid billing return URL.")
  return url.href
}

export const checkout = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    return runConvex(
      Effect.gen(function* () {
        const stripe = yield* attemptSync(client)
        if (!process.env.STRIPE_PRICE_ID)
          return yield* Effect.fail(
            appError(
              "NOT_CONFIGURED",
              "Configure a Stripe test subscription price."
            )
          )
        const account = yield* attempt(() =>
          ctx.runMutation(internal.billing.forCheckout, {})
        )
        let customerId = account.customerId
        if (!customerId) {
          const customer = yield* external(
            () =>
              stripe.customers.create(
                {
                  email: account.email,
                  metadata: { billingAccountId: account.id },
                },
                { idempotencyKey: `account:${account.id}` }
              ),
            "Billing service"
          )
          customerId = customer.id
          yield* attempt(() =>
            ctx.runMutation(internal.billing.attachCustomer, {
              accountId: account.id,
              customerId: customer.id,
            })
          )
        }
        const subscriptions = stripe.subscriptions
          .list({ customer: customerId!, status: "all", limit: 100 })
          [Symbol.asyncIterator]()
        while (true) {
          const next = yield* external(
            () => subscriptions.next(),
            "Billing service"
          )
          if (next.done) break
          const subscription = next.value
          if (
            !["canceled", "incomplete_expired"].includes(subscription.status)
          ) {
            const portal = yield* external(
              () =>
                stripe.billingPortal.sessions.create({
                  customer: customerId!,
                  return_url: returnUrl(),
                }),
              "Billing service"
            )
            return { url: portal.url }
          }
        }
        const session = yield* external(
          () =>
            stripe.checkout.sessions.create(
              {
                customer: customerId!,
                mode: "subscription",
                line_items: [
                  { price: process.env.STRIPE_PRICE_ID, quantity: 1 },
                ],
                client_reference_id: account.id,
                success_url: `${returnUrl()}?billing=success`,
                cancel_url: returnUrl(),
              },
              {
                idempotencyKey: `checkout:${account.id}:${Math.floor(Date.now() / 1800000)}`,
              }
            ),
          "Billing service"
        )
        if (!session.url)
          return yield* Effect.fail(
            appError("BAD_GATEWAY", "Checkout did not return a URL.")
          )
        return { url: session.url }
      }),
      "stripe_checkout"
    )
  },
})

export const portal = action({
  args: {},
  handler: async (ctx): Promise<{ url: string }> => {
    return runConvex(
      Effect.gen(function* () {
        const account = yield* attempt(() =>
          ctx.runMutation(internal.billing.forCheckout, {})
        )
        if (!account.customerId)
          return yield* Effect.fail(
            appError("NOT_FOUND", "This account has no billing customer yet.")
          )
        const stripe = yield* attemptSync(client)
        const session = yield* external(
          () =>
            stripe.billingPortal.sessions.create({
              customer: account.customerId,
              return_url: returnUrl(),
            }),
          "Billing service"
        )
        return { url: session.url }
      }),
      "stripe_portal"
    )
  },
})

export const webhook = internalAction({
  args: { body: v.string(), signature: v.string() },
  handler: async (ctx, { body, signature }): Promise<{ received: true }> => {
    return runConvex(
      Effect.gen(function* () {
        const stripe = yield* attemptSync(client)
        if (!process.env.STRIPE_WEBHOOK_SECRET)
          return yield* Effect.fail(
            appError("NOT_CONFIGURED", "Stripe webhook is not configured.")
          )
        const event = yield* attemptSync(
          () =>
            stripe.webhooks.constructEvent(
              body,
              signature,
              process.env.STRIPE_WEBHOOK_SECRET!
            ),
          (error) =>
            error instanceof Stripe.errors.StripeSignatureVerificationError
              ? appError("UNAUTHORIZED", "Invalid Stripe webhook signature.")
              : error instanceof SyntaxError
                ? appError(
                    "VALIDATION",
                    "Stripe event must contain valid JSON."
                  )
                : undefined
        )
        if (event.livemode)
          return yield* Effect.fail(
            appError("FORBIDDEN", "This prototype accepts test events only.")
          )
        const supported = [
          "entitlements.active_entitlement_summary.updated",
          "customer.subscription.created",
          "customer.subscription.updated",
          "customer.subscription.deleted",
        ]
        if (!supported.includes(event.type)) return { received: true }
        const object = event.data.object as {
          customer?:
            | string
            | {
                id: string
              }
        }
        const customerId =
          typeof object.customer === "string"
            ? object.customer
            : object.customer?.id
        if (!customerId)
          return yield* Effect.fail(
            appError("VALIDATION", "Stripe event is missing its customer.")
          )
        const sync = yield* attempt(() =>
          ctx.runMutation(internal.billing.beginSync, {
            customerId,
            eventId: event.id,
          })
        )
        if (!sync) return { received: true }
        const entitlements: string[] = []
        const entries = stripe.entitlements.activeEntitlements
          .list({ customer: customerId!, limit: 100 })
          [Symbol.asyncIterator]()
        while (true) {
          const next = yield* external(() => entries.next(), "Billing service")
          if (next.done) break
          entitlements.push(next.value.lookup_key)
        }
        yield* attempt(() =>
          ctx.runMutation(internal.billing.finishSync, {
            ...sync,
            customerId,
            eventId: event.id,
            entitlements,
          })
        )
        return { received: true }
      }),
      "stripe_webhook"
    )
  },
})
