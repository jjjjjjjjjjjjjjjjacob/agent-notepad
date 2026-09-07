/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import Stripe from "stripe"
import schema from "../convex/schema"
import { api, components, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { digest } from "../lib/hash"
import { PRIVATE_LIMITS, SERVICE_PERIOD_MS } from "../lib/commerce"

const provider = vi.hoisted(() => ({
  customer: vi.fn(),
  checkout: vi.fn(),
  session: vi.fn(),
  payment: vi.fn(),
  raw: vi.fn(),
  subscription: vi.fn(),
  update: vi.fn(),
  invoice: vi.fn(),
  invoicePayments: vi.fn(),
}))
vi.mock("stripe", async (original) => {
  const actual = await original<typeof import("stripe")>()
  return {
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args)
        this.customers.create = provider.customer
        this.checkout.sessions.create = provider.checkout
        this.checkout.sessions.retrieve = provider.session
        this.paymentIntents.retrieve = provider.payment
        this.rawRequest = provider.raw
        this.subscriptions.retrieve = provider.subscription
        this.subscriptions.update = provider.update
        this.invoices.retrieve = provider.invoice
        this.invoicePayments.list = provider.invoicePayments
      }
    },
  }
})
const modules = import.meta.glob("../convex/**/*.ts")
function setup() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
async function agent(t: Test, slug = "payer") {
  const token = `an_test_${slug}`
  const result = await t.mutation(internal.agents.create, {
    input: { name: slug, slug },
    hash: digest(token),
    prefix: token.slice(0, 10),
  })
  return { token, id: result.agentId as Id<"agents"> }
}
async function request(
  t: Test,
  path: string,
  token = "",
  input?: unknown,
  key = "request-1"
) {
  return t.fetch(`/api/v1/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
      "Idempotency-Key": key,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  })
}
async function purchase(
  t: Test,
  token: string,
  input: object = {},
  key = "purchase-1"
) {
  const response = await request(
    t,
    "commands/purchase",
    token,
    { product: "private_notepad", mode: "one_time", ...input },
    key
  )
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).data as {
    id: Id<"purchases">
    checkoutUrl: string | null
    spaceId: Id<"privateSpaces"> | null
  }
}
function paidPayment(id: string, purchaseId: string) {
  return {
    id,
    livemode: false,
    customer: "cus_payer",
    currency: "usd",
    amount: 500,
    amount_received: 500,
    status: "succeeded",
    metadata: { agentNotepadPurchase: purchaseId },
    latest_charge: {
      id: "ch_test",
      refunded: false,
      disputed: false,
      receipt_url: "https://pay.stripe.com/receipts/fixture",
    },
  }
}
async function pay(t: Test, token: string, id: Id<"purchases">) {
  const created = provider.checkout.mock.calls.at(-1)![0]
  provider.session.mockResolvedValue({
    ...created,
    id: "cs_test",
    amount_total: created.line_items[0].price_data.unit_amount,
    currency: "usd",
    livemode: false,
    status: "complete",
    payment_intent: "pi_test",
  })
  const amount = created.line_items[0].price_data.unit_amount
  provider.payment.mockResolvedValue({
    ...paidPayment("pi_test", id),
    amount,
    amount_received: amount,
  })
  const response = await request(t, "commands/refresh_purchase", token, {
    purchaseId: id,
  })
  expect(response.status, await response.clone().text()).toBe(200)
  return (await response.json()).data as {
    spaceId: Id<"privateSpaces">
    paidThrough: number
    receiptUrl: string | null
    paidFrom: number
  }
}
async function write(
  t: Test,
  token: string,
  spaceId: string,
  input: object = {},
  key = "write-1"
) {
  return request(
    t,
    "commands/private_write",
    token,
    { spaceId, body: "Orchid confidential research", ...input },
    key
  )
}
async function event(t: Test, type: string, object: object, id = "evt_test") {
  const body = JSON.stringify({
    id,
    type,
    object: "event",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object },
  })
  return t.fetch("/stripe/webhook", {
    method: "POST",
    headers: {
      "stripe-signature": Stripe.webhooks.generateTestHeaderString({
        payload: body,
        secret: "whsec_test",
      }),
    },
    body,
  })
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake")
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test")
  vi.stubEnv("SITE_URL", "http://localhost:4242")
  vi.stubEnv("STRIPE_AGENT_PROFILE_ID", "profile_test")
  vi.stubEnv("WRITE_GATEWAY_REQUIRED", "false")
  vi.stubEnv("MODERATION_ENABLED", "false")
  provider.customer.mockResolvedValue({ id: "cus_payer" })
  provider.checkout.mockResolvedValue({
    id: "cs_test",
    url: "https://checkout.stripe.com/test",
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("direct agent commerce", () => {
  it("never writes an unverified renewal's invoice dates into service access", async () => {
    const t = setup()
    const a = await agent(t)
    const original = await purchase(t, a.token)
    const first = await pay(t, a.token, original.id)
    provider.checkout.mockResolvedValue({
      id: "cs_unpaid",
      url: "https://checkout.stripe.com/unpaid",
    })
    const renewal = await purchase(
      t,
      a.token,
      { spaceId: first.spaceId, mode: "subscription" },
      "unpaid-renewal"
    )
    const sync = (await t.mutation(internal.commerceRecords.beginSync, {
      purchaseId: renewal.id,
    }))!
    await t.mutation(internal.commerceRecords.finishSync, {
      purchaseId: renewal.id,
      generation: sync.generation,
      status: "incomplete",
      paid: false,
      revoked: false,
      paidFrom: first.paidThrough,
      paidThrough: first.paidThrough + SERVICE_PERIOD_MS,
    })
    expect(
      (await t.run((ctx) => ctx.db.get(renewal.id)))?.paidThrough
    ).toBeUndefined()
    vi.setSystemTime(first.paidThrough + 1)
    expect((await write(t, a.token, first.spaceId)).status).toBe(403)
  })
  it("fulfills a signed checkout event even when the action lost its provider response", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token)
    await t.run((ctx) =>
      ctx.db.patch(p.id, { checkoutId: undefined, checkoutUrl: undefined })
    )
    const created = provider.checkout.mock.calls[0][0]
    provider.session.mockResolvedValue({
      ...created,
      id: "cs_test",
      amount_total: 500,
      currency: "usd",
      livemode: false,
      status: "complete",
      payment_intent: "pi_test",
    })
    provider.payment.mockResolvedValue(paidPayment("pi_test", p.id))
    expect(
      (
        await event(t, "checkout.session.completed", {
          id: "cs_test",
          customer: "cus_payer",
          metadata: created.metadata,
        })
      ).status
    ).toBe(200)
    expect((await t.run((ctx) => ctx.db.get(p.id)))?.spaceId).toBeDefined()
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(1)
  })

  it("sells chat for $3, supports channels and queues one-time renewal without duplicating time", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token, { product: "private_chat" })
    const first = await pay(t, a.token, p.id)
    expect(
      provider.checkout.mock.calls[0][0].line_items[0].price_data.unit_amount
    ).toBe(300)
    expect(
      (
        await request(t, "commands/private_channel", a.token, {
          spaceId: first.spaceId,
          name: "research",
        })
      ).status
    ).toBe(200)
    expect(
      (await write(t, a.token, first.spaceId, { channel: "research" })).status
    ).toBe(200)
    provider.checkout.mockResolvedValue({
      id: "cs_renewal",
      url: "https://checkout.stripe.com/renewal",
    })
    const renewal = await purchase(
      t,
      a.token,
      { product: "private_chat", spaceId: first.spaceId },
      "renewal"
    )
    const second = await pay(t, a.token, renewal.id)
    expect(second.spaceId).toBe(first.spaceId)
    expect(second.paidFrom).toBe(first.paidThrough)
    expect(second.paidThrough).toBe(first.paidThrough + SERVICE_PERIOD_MS)
    const again = await pay(t, a.token, renewal.id)
    expect(again.paidThrough).toBe(second.paidThrough)
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(1)
  })

  it("takes support payments without creating a space, balance, or verification badge", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token, {
      product: "support",
      amountCents: 1200,
    })
    await pay(t, a.token, p.id)
    expect((await t.run((ctx) => ctx.db.get(p.id)))?.amountCents).toBe(1200)
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(0)
    expect(
      (await t.query(api.public.getAgent, { slug: "payer" }))?.humanVerified
    ).toBe(false)
    expect(
      await t.run((ctx) => ctx.db.query("billingAccounts").collect())
    ).toHaveLength(0)
  })
  it("lets an unlinked agent purchase, pay, write, and retry without public disclosure", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token)
    expect((await t.run((ctx) => ctx.db.get(a.id)))?.ownerId).toBeUndefined()
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(0)
    const same = await purchase(t, a.token)
    expect(same.id).toBe(p.id)
    expect(provider.checkout).toHaveBeenCalledTimes(1)
    expect(
      (
        await request(
          t,
          "commands/purchase",
          a.token,
          { product: "private_chat" },
          "purchase-1"
        )
      ).status
    ).toBe(409)
    const access = await pay(t, a.token, p.id)
    expect(access.receiptUrl).toBe("https://pay.stripe.com/receipts/fixture")
    expect(access.paidThrough - access.paidFrom).toBe(SERVICE_PERIOD_MS)
    const result = await write(t, a.token, access.spaceId)
    expect(result.status).toBe(200)
    expect(await (await write(t, a.token, access.spaceId)).json()).toEqual(
      await result.json()
    )
    expect(
      await t.run((ctx) => ctx.db.query("privateEntries").collect())
    ).toHaveLength(1)
    expect(
      await t.run((ctx) => ctx.db.query("resources").collect())
    ).toHaveLength(0)
    expect(
      await t.run((ctx) => ctx.db.query("searchDocuments").collect())
    ).toHaveLength(0)
    expect(
      await t.query(api.public.getResource, { slugOrId: access.spaceId })
    ).toBeNull()
    expect(
      (await request(t, `private_entries?spaceId=${access.spaceId}`, a.token))
        .status
    ).toBe(200)
    expect(
      (await request(t, `private_entries?spaceId=${access.spaceId}`)).status
    ).toBe(401)
    const b = await agent(t, "intruder")
    for (const op of [
      "private_space",
      "private_entries",
      "private_members",
      "private_search",
    ])
      expect(
        (
          await request(
            t,
            `${op}?spaceId=${access.spaceId}&query=Orchid`,
            b.token
          )
        ).status
      ).toBe(404)
    expect(
      (await request(t, `purchase?purchaseId=${p.id}`, b.token)).status
    ).toBe(404)
    await expect(
      t.query(api.privateSpaces.humanRead, {
        agentId: a.id,
        operation: "private_space",
        input: { spaceId: access.spaceId },
      })
    ).rejects.toThrow("UNAUTHORIZED")
  })

  it("enforces server prices, scopes, exact provider binding, mode, and paid state", async () => {
    const t = setup()
    const a = await agent(t)
    expect(
      (
        await request(t, "commands/purchase", a.token, {
          product: "private_notepad",
          amountCents: 1,
        })
      ).status
    ).toBe(400)
    await t.run(async (ctx) => {
      const k = await ctx.db.query("keys").first()
      await ctx.db.patch(k!._id, { scopes: ["social:write"] })
    })
    expect(
      (
        await request(t, "commands/purchase", a.token, {
          product: "private_notepad",
        })
      ).status
    ).toBe(403)
    await t.run(async (ctx) => {
      const k = await ctx.db.query("keys").first()
      await ctx.db.patch(k!._id, { scopes: ["keys:write"] })
    })
    expect(
      (
        await request(t, "commands/purchase", a.token, {
          product: "private_notepad",
        })
      ).status
    ).toBe(403)
    expect(
      (
        await request(t, "commands/enable_commerce", a.token, {
          scopes: [
            "billing:write",
            "private:read",
            "private:write",
            "private:manage",
          ],
        })
      ).status
    ).toBe(200)
    const p = await purchase(t, a.token)
    const base = {
      ...provider.checkout.mock.calls[0][0],
      id: "cs_test",
      livemode: false,
      currency: "usd",
      amount_total: 500,
      status: "complete",
      payment_intent: "pi_test",
    }
    provider.payment.mockResolvedValue({
      ...paidPayment("pi_test", p.id),
      status: "processing",
    })
    provider.session.mockResolvedValue(base)
    expect(
      (
        await request(t, "commands/refresh_purchase", a.token, {
          purchaseId: p.id,
        })
      ).status
    ).toBe(200)
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(0)
    for (const changed of [
      { customer: "cus_intruder" },
      { amount_total: 100 },
      { livemode: true },
      { metadata: { agentNotepadPurchase: "other" } },
    ]) {
      provider.session.mockResolvedValue({ ...base, ...changed })
      expect(
        (
          await request(t, "commands/refresh_purchase", a.token, {
            purchaseId: p.id,
          })
        ).status
      ).toBe(403)
    }
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(0)
  })

  it("handles signed webhook races, duplicates, stale syncs, and refunds", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token)
    await pay(t, a.token, p.id)
    const payment = paidPayment("pi_test", p.id)
    const object = {
      id: "cs_test",
      customer: "cus_payer",
      metadata: payment.metadata,
    }
    expect((await event(t, "checkout.session.completed", object)).status).toBe(
      200
    )
    expect((await event(t, "checkout.session.completed", object)).status).toBe(
      200
    )
    expect(
      await t.run((ctx) => ctx.db.query("privateSpaces").collect())
    ).toHaveLength(1)
    expect(
      await t.run((ctx) => ctx.db.query("commerceEvents").collect())
    ).toHaveLength(1)
    const old = (await t.mutation(internal.commerceRecords.beginSync, {
      purchaseId: p.id,
    }))!
    provider.payment.mockResolvedValue({
      ...payment,
      latest_charge: { refunded: true, disputed: false },
    })
    expect(
      (
        await event(
          t,
          "charge.refunded",
          { id: "ch_test", payment_intent: "pi_test" },
          "evt_refund"
        )
      ).status
    ).toBe(200)
    expect(
      await t.mutation(internal.commerceRecords.finishSync, {
        purchaseId: p.id,
        generation: old.generation,
        status: "paid",
        paid: true,
        revoked: false,
      })
    ).toBe(false)
    const row = await t.run((ctx) => ctx.db.get(p.id))
    expect((await write(t, a.token, row!.spaceId!)).status).toBe(403)
    expect(
      (await request(t, `private_entries?spaceId=${row!.spaceId}`, a.token))
        .status
    ).toBe(200)
    expect(
      (
        await t.fetch("/stripe/webhook", {
          method: "POST",
          headers: { "stripe-signature": "forged" },
          body: "{}",
        })
      ).status
    ).toBe(400)
  })

  it("accepts a one-time Link credential and never persists the token", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token, { payment: "link_token" })
    provider.raw.mockResolvedValue({ id: "pi_link" })
    provider.payment.mockResolvedValue(paidPayment("pi_link", p.id))
    const input = { purchaseId: p.id, sharedPaymentToken: "spt_fixture_secret" }
    expect(
      (await request(t, "commands/pay_purchase", a.token, input)).status
    ).toBe(200)
    expect(
      (await request(t, "commands/pay_purchase", a.token, input)).status
    ).toBe(200)
    expect(provider.raw).toHaveBeenCalledTimes(1)
    expect(provider.raw.mock.calls[0][2]).toMatchObject({
      amount: 500,
      customer: "cus_payer",
      payment_method_data: {
        shared_payment_granted_token: input.sharedPaymentToken,
      },
    })
    expect(
      JSON.stringify(await t.run((ctx) => ctx.db.query("purchases").collect()))
    ).not.toContain(input.sharedPaymentToken)
    expect(
      (
        await request(t, "commands/pay_purchase", a.token, {
          ...input,
          sharedPaymentToken: "spt_different",
        })
      ).status
    ).toBe(409)
    expect(
      (
        await request(
          t,
          "commands/purchase",
          a.token,
          { product: "support", payment: "link_token", mode: "subscription" },
          "invalid"
        )
      ).status
    ).toBe(400)
    const unpaid = await purchase(
      t,
      a.token,
      { payment: "link_token" },
      "old-purchase"
    )
    vi.setSystemTime(Date.now() + 24 * 3_600_000)
    expect(
      (
        await request(t, "commands/pay_purchase", a.token, {
          ...input,
          purchaseId: unpaid.id,
        })
      ).status
    ).toBe(409)
    expect(provider.raw).toHaveBeenCalledTimes(1)
  })

  it("uses paid invoice periods and cancels renewal without erasing purchased access", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token, { mode: "subscription" })
    const checkout = provider.checkout.mock.calls[0][0]
    const start = Math.floor(Date.now() / 1000),
      end = start + 28 * 86_400
    provider.session.mockResolvedValue({
      ...checkout,
      id: "cs_test",
      amount_total: 500,
      currency: "usd",
      livemode: false,
      status: "complete",
      subscription: "sub_test",
    })
    const sub = {
      id: "sub_test",
      livemode: false,
      customer: "cus_payer",
      metadata: checkout.metadata,
      status: "active",
      cancel_at_period_end: false,
      latest_invoice: "in_test",
      items: {
        has_more: false,
        data: [
          {
            id: "si_test",
            quantity: 1,
            price: {
              unit_amount: 500,
              currency: "usd",
              recurring: { interval: "month", interval_count: 1 },
            },
          },
        ],
      },
    }
    provider.subscription.mockResolvedValue(sub)
    provider.invoice.mockResolvedValue({
      id: "in_test",
      livemode: false,
      customer: "cus_payer",
      currency: "usd",
      status: "paid",
      amount_paid: 500,
      lines: {
        data: [
          {
            amount: 500,
            parent: {
              subscription_item_details: { subscription_item: "si_test" },
            },
            period: { start, end },
          },
        ],
      },
    })
    provider.invoicePayments.mockResolvedValue({
      data: [
        {
          status: "paid",
          payment: {
            type: "payment_intent",
            payment_intent: "pi_subscription",
          },
        },
      ],
    })
    provider.payment.mockResolvedValue(paidPayment("pi_subscription", p.id))
    expect(
      (
        await request(t, "commands/refresh_purchase", a.token, {
          purchaseId: p.id,
        })
      ).status
    ).toBe(200)
    const row = await t.run((ctx) => ctx.db.get(p.id))
    expect(row!.paidThrough).toBe(end * 1000)
    provider.subscription.mockResolvedValue({
      ...sub,
      cancel_at_period_end: true,
    })
    expect(
      (
        await request(t, "commands/cancel_subscription", a.token, {
          purchaseId: p.id,
        })
      ).status
    ).toBe(200)
    expect(provider.update).toHaveBeenCalledWith(
      "sub_test",
      { cancel_at_period_end: true },
      expect.anything()
    )
    expect((await write(t, a.token, row!.spaceId!)).status).toBe(200)
    vi.setSystemTime(end * 1000 + 1)
    expect(
      (await write(t, a.token, row!.spaceId!, {}, "expired-write")).status
    ).toBe(403)
    expect(
      (await request(t, `private_entries?spaceId=${row!.spaceId}`, a.token))
        .status
    ).toBe(200)
  })
})

describe("private storage permissions", () => {
  it("enforces reader/writer roles, immediate removal, revision conflicts, history and quotas", async () => {
    const t = setup()
    const a = await agent(t)
    const b = await agent(t, "member")
    const p = await purchase(t, a.token)
    const space = await pay(t, a.token, p.id)
    const input = { spaceId: space.spaceId, agentId: b.id, role: "reader" }
    expect(
      (await request(t, "commands/private_member", a.token, input, "reader"))
        .status
    ).toBe(200)
    expect((await write(t, b.token, space.spaceId)).status).toBe(403)
    expect(
      (
        await request(
          t,
          "commands/private_member",
          a.token,
          { ...input, role: "writer" },
          "writer"
        )
      ).status
    ).toBe(200)
    const response = await write(t, b.token, space.spaceId)
    expect(response.status).toBe(200)
    const entry = (await response.json()).data
    expect(
      (
        await write(
          t,
          b.token,
          space.spaceId,
          {
            entryId: entry.entryId,
            baseRevision: 1,
            body: "Revised confidential text",
          },
          "edit"
        )
      ).status
    ).toBe(200)
    expect(
      (
        await write(
          t,
          b.token,
          space.spaceId,
          { entryId: entry.entryId, baseRevision: 1 },
          "conflict"
        )
      ).status
    ).toBe(409)
    const history = await request(
      t,
      `private_history?spaceId=${space.spaceId}&entryId=${entry.entryId}`,
      b.token
    )
    expect((await history.json()).data.items).toHaveLength(2)
    expect(
      (await request(t, "commands/private_member", b.token, input, "steal"))
        .status
    ).toBe(403)
    expect(
      (
        await request(
          t,
          "commands/private_member",
          a.token,
          { ...input, role: "remove" },
          "remove"
        )
      ).status
    ).toBe(200)
    expect((await write(t, b.token, space.spaceId)).status).toBe(404)
    expect(
      (
        await request(
          t,
          `private_history?spaceId=${space.spaceId}&entryId=${entry.entryId}`,
          b.token
        )
      ).status
    ).toBe(404)
    await t.run((ctx) =>
      ctx.db.patch(space.spaceId, { bytes: PRIVATE_LIMITS.bytes })
    )
    expect((await write(t, a.token, space.spaceId)).status).toBe(400)
  })

  it("lets only a linked manager act for an agent, without changing its billing ownership", async () => {
    const t = setup()
    const a = await agent(t)
    const p = await purchase(t, a.token)
    const space = await pay(t, a.token, p.id)
    const user = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "user",
        data: {
          name: "Manager",
          email: "manager@example.com",
          emailVerified: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    const session = await t.mutation(components.betterAuth.adapter.create, {
      input: {
        model: "session",
        data: {
          userId: user._id,
          token: "fixture-session",
          expiresAt: Date.now() + 3_600_000,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        },
      },
    })
    const human = t.withIdentity({ subject: user._id, sessionId: session._id })
    await expect(
      human.query(api.privateSpaces.humanRead, {
        agentId: a.id,
        operation: "private_space",
        input: { spaceId: space.spaceId },
      })
    ).rejects.toThrow("FORBIDDEN")
    await t.run((ctx) => ctx.db.patch(a.id, { ownerId: user._id }))
    expect(
      await human.query(api.privateSpaces.humanRead, {
        agentId: a.id,
        operation: "private_space",
        input: { spaceId: space.spaceId },
      })
    ).toMatchObject({ ownerAgentId: a.id })
    expect((await t.run((ctx) => ctx.db.get(p.id)))?.agentId).toBe(a.id)
    const profile = await t.query(api.public.getAgent, { slug: "payer" })
    expect(profile).not.toHaveProperty("ownerId")
    expect(JSON.stringify(profile)).not.toContain("manager@example.com")
  })
})
