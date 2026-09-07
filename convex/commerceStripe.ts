"use node"
import Stripe from "stripe"
import { STRIPE_API_VERSION } from "../lib/stripe-config"
import { v, ConvexError } from "convex/values"
import { z } from "zod"
import { action, internalAction } from "./_generated/server"
import type { ActionCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { internal } from "./_generated/api"
import { actorArgs, purchaseView } from "./commerceRecords"
import {
  commerceCommands,
  commerceConfigured,
  commerceMode,
  products,
  type CommerceOperation,
} from "../lib/commerce"
import { fail } from "./lib/core"
import { digest } from "../lib/hash"

function client() {
  if (!commerceConfigured())
    fail(
      "NOT_CONFIGURED",
      "Set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, and SITE_URL."
    )
  return new Stripe(process.env.STRIPE_SECRET_KEY!, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: 2,
    timeout: 15_000,
  })
}
function returnUrl() {
  const url = new URL("/billing/return", process.env.SITE_URL)
  if (
    url.protocol !== "https:" &&
    !(
      commerceMode() === "test" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    fail(
      "NOT_CONFIGURED",
      "Stripe requires an HTTPS SITE_URL (localhost is allowed in test mode)."
    )
  return url.href
}
const providerId = (value: string | { id: string } | null | undefined) =>
  typeof value === "string" ? value : value?.id
function assertEnvironment(livemode: boolean, purchase: Doc<"purchases">) {
  if (
    livemode !== (purchase.mode === "live") ||
    purchase.mode !== commerceMode()
  )
    fail("FORBIDDEN", "Payment environment does not match the purchase.")
}
type Actor = {
  token?: string | import("./lib/agentIdentity").WorkosPrincipal
  humanAgentId?: string
}

async function create(
  ctx: ActionCtx,
  actor: Actor,
  input: unknown,
  key: string
) {
  const stripe = client()
  const back = returnUrl()
  const prepared = await ctx.runMutation(internal.commerceRecords.prepare, {
    ...actor,
    input,
    requestKey: key,
  })
  const p = prepared.purchase
  if (p.checkoutId || p.paymentIntentId || p.status !== "pending")
    return purchaseView(p)
  // Stripe idempotency keys expire after at least 24h. Never silently create
  // another external checkout/customer after an unresolved old attempt.
  if (Date.now() - p.createdAt > 23 * 3_600_000)
    fail(
      "CONFLICT",
      "This incomplete purchase needs reconciliation; start a new purchase only after its status is resolved."
    )
  let customerId = prepared.account.stripeCustomerId
  if (!customerId) {
    const customer = await stripe.customers.create(
      { metadata: { agentNotepadAccount: prepared.account._id } },
      { idempotencyKey: `an-customer:${prepared.account._id}` }
    )
    customerId = customer.id
    await ctx.runMutation(internal.commerceRecords.bindCustomer, {
      accountId: prepared.account._id,
      customerId,
    })
  }
  await ctx.runMutation(internal.commerceRecords.bindPayment, {
    purchaseId: p._id,
    customerId,
  })
  if (p.payment === "link_token")
    return {
      ...purchaseView(p),
      linkProfileId: process.env.STRIPE_AGENT_PROFILE_ID,
      next: "Obtain a one-time shared payment token for this amount and profile, then call pay_purchase with this purchase ID.",
    }
  const metadata = { agentNotepadPurchase: p._id }
  const session = await stripe.checkout.sessions.create(
    {
      customer: customerId,
      mode: p.purchaseMode === "subscription" ? "subscription" : "payment",
      client_reference_id: p._id,
      metadata,
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: p.amountCents,
            product_data: {
              name: products[p.product].name,
              description:
                p.product === "support"
                  ? "Support public knowledge and collaboration for agents."
                  : p.purchaseMode === "subscription"
                    ? "Private text space. Renews monthly; cancel any time."
                    : "30 days of private text space. Does not renew automatically.",
            },
            ...(p.purchaseMode === "subscription"
              ? { recurring: { interval: "month" as const } }
              : {}),
          },
          quantity: 1,
        },
      ],
      ...(p.purchaseMode === "subscription"
        ? { subscription_data: { metadata } }
        : { payment_intent_data: { metadata } }),
      payment_method_types: ["card", "link"],
      success_url: back,
      cancel_url: back,
      expires_at: Math.floor(p.createdAt / 1000) + 23 * 3600,
    },
    { idempotencyKey: `an-checkout:${p._id}` }
  )
  if (!session.url) fail("INTERNAL", "Stripe did not return a checkout URL.")
  await ctx.runMutation(internal.commerceRecords.bindPayment, {
    purchaseId: p._id,
    customerId,
    checkoutId: session.id,
    checkoutUrl: session.url,
  })
  return { ...purchaseView(p), checkoutUrl: session.url }
}

async function paymentState(
  stripe: Stripe,
  paymentId: string,
  p: Doc<"purchases">,
  customerId: string
) {
  const payment = await stripe.paymentIntents.retrieve(paymentId, {
    expand: ["latest_charge"],
  })
  assertEnvironment(payment.livemode, p)
  if (
    providerId(payment.customer) !== customerId ||
    payment.currency !== "usd" ||
    payment.amount < p.amountCents
  )
    fail("FORBIDDEN", "Payment does not match its purchase.")
  const charge =
    typeof payment.latest_charge === "string"
      ? await stripe.charges.retrieve(payment.latest_charge)
      : payment.latest_charge
  return {
    payment,
    receiptUrl: charge?.receipt_url ?? undefined,
    revoked: !!charge && (charge.refunded || charge.disputed),
    paid:
      payment.status === "succeeded" &&
      payment.amount_received >= p.amountCents,
  }
}

async function reconcile(
  ctx: ActionCtx,
  purchaseId: Id<"purchases">,
  eventId?: string
) {
  const stripe = client()
  const sync = await ctx.runMutation(internal.commerceRecords.beginSync, {
    purchaseId,
    ...(eventId ? { eventId } : {}),
  })
  if (!sync) return
  const p = sync.purchase
  if (p.mode !== commerceMode() || !sync.customerId)
    fail("CONFLICT", "Purchase customer is not ready for reconciliation.")
  let subscriptionId = p.subscriptionId
  let paymentIntentId = p.paymentIntentId
  let status = p.status
  let paid = false
  let revoked = p.revoked ?? false
  let paidFrom: number | undefined
  let paidThrough: number | undefined
  let cancelAtPeriodEnd: boolean | undefined
  let receiptUrl: string | undefined
  if (p.checkoutId) {
    const session = await stripe.checkout.sessions.retrieve(p.checkoutId)
    assertEnvironment(session.livemode, p)
    if (
      session.metadata?.agentNotepadPurchase !== p._id ||
      session.client_reference_id !== p._id ||
      providerId(session.customer) !== sync.customerId ||
      session.currency !== "usd" ||
      (session.amount_total ?? 0) !== p.amountCents ||
      session.mode !==
        (p.purchaseMode === "subscription" ? "subscription" : "payment")
    )
      fail("FORBIDDEN", "Checkout does not match its purchase.")
    status = session.status === "expired" ? "expired" : "pending"
    subscriptionId = providerId(session.subscription) ?? subscriptionId
    paymentIntentId = providerId(session.payment_intent) ?? paymentIntentId
  }
  if (subscriptionId) {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId)
    assertEnvironment(subscription.livemode, p)
    const item = subscription.items.data[0]
    if (
      subscription.metadata.agentNotepadPurchase !== p._id ||
      providerId(subscription.customer) !== sync.customerId ||
      subscription.items.has_more ||
      subscription.items.data.length !== 1 ||
      !item ||
      item.quantity !== 1 ||
      item.price.unit_amount !== p.amountCents ||
      item.price.currency !== "usd" ||
      item.price.recurring?.interval !== "month" ||
      item.price.recurring.interval_count !== 1
    )
      fail("FORBIDDEN", "Subscription does not match its purchase.")
    status = subscription.status
    cancelAtPeriodEnd = subscription.cancel_at_period_end
    const invoiceId = providerId(subscription.latest_invoice)
    if (invoiceId) {
      const invoice = await stripe.invoices.retrieve(invoiceId)
      assertEnvironment(invoice.livemode, p)
      if (
        providerId(invoice.customer) !== sync.customerId ||
        invoice.currency !== "usd"
      )
        fail("FORBIDDEN", "Invoice does not match its purchase.")
      const payments = await stripe.invoicePayments.list({
        invoice: invoice.id,
        limit: 10,
      })
      const invoicePayment = payments.data.find(
        (x) => x.status === "paid" && x.payment.type === "payment_intent"
      )
      const invoicePaymentId = providerId(
        invoicePayment?.payment.payment_intent
      )
      if (
        invoice.status === "paid" &&
        invoice.amount_paid >= p.amountCents &&
        invoicePaymentId
      ) {
        paymentIntentId = invoicePaymentId
        const state = await paymentState(
          stripe,
          invoicePaymentId,
          p,
          sync.customerId
        )
        paid = state.paid
        revoked = state.revoked
        receiptUrl = state.receiptUrl
        const line = invoice.lines.data.find(
          (x) =>
            x.parent?.subscription_item_details?.subscription_item ===
              item.id && x.amount >= p.amountCents
        )
        if (paid && !line)
          fail("CONFLICT", "Paid invoice has no matching service period.")
        paidFrom = line ? line.period.start * 1000 : undefined
        paidThrough = line ? line.period.end * 1000 : undefined
      }
    }
    // A new unpaid invoice must not hide a refund of the last paid period.
    if (!paid && p.paymentIntentId) {
      const previous = await paymentState(
        stripe,
        p.paymentIntentId,
        p,
        sync.customerId
      )
      if (previous.revoked) revoked = true
    }
    if (["unpaid", "paused", "incomplete_expired"].includes(status))
      revoked = true
  } else if (paymentIntentId) {
    const state = await paymentState(
      stripe,
      paymentIntentId,
      p,
      sync.customerId
    )
    if (
      state.payment.amount !== p.amountCents ||
      state.payment.metadata.agentNotepadPurchase !== p._id
    )
      fail("FORBIDDEN", "Payment amount or reference does not match.")
    paid = state.paid
    revoked = state.revoked
    receiptUrl = state.receiptUrl
    status = revoked
      ? "refunded_or_disputed"
      : paid
        ? "paid"
        : state.payment.status
  } else if (
    p.payment === "link_token" &&
    Date.now() - p.createdAt > 86_400_000
  )
    status = "expired"
  await ctx.runMutation(internal.commerceRecords.finishSync, {
    purchaseId,
    generation: sync.generation,
    ...(eventId ? { eventId } : {}),
    status,
    paid,
    revoked,
    ...(subscriptionId ? { subscriptionId } : {}),
    ...(paymentIntentId ? { paymentIntentId } : {}),
    ...(paidFrom ? { paidFrom } : {}),
    ...(paidThrough ? { paidThrough } : {}),
    ...(cancelAtPeriodEnd !== undefined ? { cancelAtPeriodEnd } : {}),
    ...(receiptUrl ? { receiptUrl } : {}),
  })
}

async function execute(
  ctx: ActionCtx,
  actor: Actor,
  operation: string,
  input: unknown,
  requestKey: string
): Promise<unknown> {
  if (!Object.hasOwn(commerceCommands, operation))
    fail("VALIDATION", "Unknown purchase operation.")
  const parsed =
    commerceCommands[operation as CommerceOperation].safeParse(input)
  if (!parsed.success) fail("VALIDATION", "Invalid purchase input.")
  if (!requestKey.trim() || requestKey.length > 128)
    fail("VALIDATION", "Supply an idempotency key of 1–128 characters.")
  if (operation === "enable_commerce") {
    if (!actor.token)
      fail("UNAUTHORIZED", "Use the local agent key that needs new scopes.")
    return ctx.runMutation(internal.commerceRecords.enableScopes, {
      token: actor.token,
      input: parsed.data,
      requestKey,
    })
  }
  const stripe = client()
  if (operation === "purchase")
    return create(ctx, actor, parsed.data, requestKey)
  const purchaseId = (parsed.data as { purchaseId: string }).purchaseId
  const p = await ctx.runMutation(internal.commerceRecords.authorize, {
    ...actor,
    purchaseId,
  })
  if (operation === "billing_portal") {
    if (!p.customerId) fail("CONFLICT", "Start the purchase first.")
    const configs = await stripe.billingPortal.configurations.list({
      active: true,
      limit: 100,
    })
    let configuration = configs.data.find(
      (config) => config.metadata?.agentNotepadPortal === "v1"
    )
    if (!configuration)
      configuration = await stripe.billingPortal.configurations.create(
        {
          metadata: { agentNotepadPortal: "v1" },
          features: {
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: "at_period_end" },
          },
          business_profile: { headline: "Manage your agent's purchases" },
        },
        { idempotencyKey: `an-portal-configuration:v1:${p.mode}` }
      )
    const session = await stripe.billingPortal.sessions.create({
      customer: p.customerId,
      configuration: configuration.id,
      return_url: returnUrl(),
    })
    return { url: session.url }
  }
  if (operation === "pay_purchase") {
    const input = commerceCommands.pay_purchase.parse(parsed.data)
    await ctx.runMutation(internal.commerceRecords.reserveToken, {
      ...actor,
      purchaseId,
      tokenHash: digest(input.sharedPaymentToken),
    })
    if (!p.customerId) fail("CONFLICT", "Start the purchase first.")
    if (!p.paymentIntentId) {
      if (Date.now() - p.createdAt > 23 * 3_600_000)
        fail(
          "CONFLICT",
          "This payment attempt has expired. Refresh it before starting another purchase."
        )
      const response = await stripe.rawRequest(
        "POST",
        "/v1/payment_intents",
        {
          amount: p.amountCents,
          currency: "usd",
          customer: p.customerId,
          metadata: { agentNotepadPurchase: p._id },
          payment_method_data: {
            shared_payment_granted_token: input.sharedPaymentToken,
          },
          confirm: true,
          return_url: returnUrl(),
        },
        { idempotencyKey: `an-payment:${p._id}` }
      )
      const payment = z
        .object({ id: z.string().startsWith("pi_") })
        .parse(response)
      await ctx.runMutation(internal.commerceRecords.bindPayment, {
        purchaseId: p._id,
        customerId: p.customerId,
        paymentIntentId: payment.id,
      })
    }
  } else if (operation === "cancel_subscription") {
    if (!p.subscriptionId)
      fail(
        "CONFLICT",
        "No subscription is attached to this purchase yet. Refresh its status first."
      )
    await stripe.subscriptions.update(
      p.subscriptionId,
      { cancel_at_period_end: true },
      { idempotencyKey: `an-cancel:${p._id}` }
    )
  }
  await reconcile(ctx, p._id)
  return ctx.runQuery(internal.commerceRecords.read, { ...actor, purchaseId })
}
async function safeExecute(
  ctx: ActionCtx,
  actor: Actor,
  operation: string,
  input: unknown,
  requestKey: string
) {
  try {
    return await execute(ctx, actor, operation, input, requestKey)
  } catch (error) {
    if (error instanceof ConvexError) throw error
    // Provider errors may contain payment details; never send them to clients or logs.
    fail(
      "INTERNAL",
      "Stripe could not complete the request. Retry with the same purchase and idempotency key."
    )
  }
}
export const agentExecute = internalAction({
  args: {
    ...actorArgs,
    operation: v.string(),
    input: v.any(),
    requestKey: v.string(),
  },
  handler: async (ctx, a): Promise<unknown> =>
    safeExecute(
      ctx,
      {
        ...(a.token !== undefined ? { token: a.token } : {}),
        ...(a.humanAgentId ? { humanAgentId: a.humanAgentId } : {}),
      },
      a.operation,
      a.input,
      a.requestKey
    ),
})
export const humanExecute = action({
  args: {
    agentId: v.string(),
    operation: v.string(),
    input: v.any(),
    requestKey: v.string(),
  },
  handler: async (ctx, a): Promise<unknown> =>
    safeExecute(
      ctx,
      { humanAgentId: a.agentId },
      a.operation,
      a.input,
      a.requestKey
    ),
})
export const sync = internalAction({
  args: { purchaseId: v.id("purchases") },
  handler: async (ctx, a): Promise<void> => {
    await reconcile(ctx, a.purchaseId)
  },
})
export const recover = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const ids = await ctx.runMutation(internal.commerceRecords.due, {})
    for (const purchaseId of ids)
      await ctx.scheduler.runAfter(0, internal.commerceStripe.sync, {
        purchaseId,
      })
  },
})
export const webhook = internalAction({
  args: { body: v.string(), signature: v.string() },
  handler: async (ctx, a): Promise<{ received: true }> => {
    const stripe = client()
    let event: Stripe.Event
    try {
      event = stripe.webhooks.constructEvent(
        a.body,
        a.signature,
        process.env.STRIPE_WEBHOOK_SECRET!
      )
    } catch {
      fail("UNAUTHORIZED", "Invalid Stripe signature.")
    }
    if (event.livemode !== (commerceMode() === "live"))
      fail("FORBIDDEN", "Webhook environment does not match.")
    const object = event.data.object as unknown as {
      id: string
      metadata?: Record<string, string>
      subscription?: string
      payment_intent?: string
      parent?: {
        subscription_details?: {
          subscription?: string
          metadata?: Record<string, string>
        }
      }
      charge?: string
    }
    const metadataId =
      object.metadata?.agentNotepadPurchase ??
      object.parent?.subscription_details?.metadata?.agentNotepadPurchase
    let p = await ctx.runQuery(internal.commerceRecords.find, {
      ...(metadataId ? { purchaseId: metadataId } : {}),
      ...(event.type.startsWith("checkout.session.")
        ? { checkoutId: object.id }
        : {}),
      ...(event.type.startsWith("customer.subscription.")
        ? { subscriptionId: object.id }
        : object.subscription ||
            object.parent?.subscription_details?.subscription
          ? {
              subscriptionId:
                object.subscription ??
                object.parent!.subscription_details!.subscription,
            }
          : {}),
      ...(event.type.startsWith("payment_intent.")
        ? { paymentIntentId: object.id }
        : object.payment_intent
          ? { paymentIntentId: object.payment_intent }
          : {}),
    })
    if (!p && event.type.startsWith("charge.dispute.") && object.charge) {
      const charge = await stripe.charges.retrieve(object.charge)
      const id = providerId(charge.payment_intent)
      if (id)
        p = await ctx.runQuery(internal.commerceRecords.find, {
          paymentIntentId: id,
        })
    }
    if (p) {
      // An event can arrive before the action saves the provider response.
      // Bind only a signed object's IDs to its existing server-owned customer;
      // reconciliation still independently retrieves and validates the object.
      const customerId = providerId(
        (event.data.object as unknown as { customer?: string }).customer
      )
      if (
        customerId &&
        ((event.type.startsWith("checkout.session.") && !p.checkoutId) ||
          (event.type.startsWith("payment_intent.") &&
            !p.paymentIntentId &&
            p.purchaseMode === "one_time"))
      ) {
        await ctx.runMutation(internal.commerceRecords.bindPayment, {
          purchaseId: p._id,
          customerId,
          ...(event.type.startsWith("checkout.session.")
            ? { checkoutId: object.id }
            : { paymentIntentId: object.id }),
        })
      }
      await reconcile(ctx, p._id, event.id)
    } else if (
      commerceMode() === "test" &&
      process.env.STRIPE_PRICE_ID &&
      [
        "entitlements.active_entitlement_summary.updated",
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
      ].includes(event.type)
    )
      await ctx.runAction(internal.stripe.webhook, a)
    return { received: true }
  },
})
