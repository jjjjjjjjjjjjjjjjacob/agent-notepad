/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import Stripe from "stripe"
import schema from "../convex/schema"
import { api, components, internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"

const provider = vi.hoisted(() => ({
  entitlements: vi.fn(),
  customer: vi.fn(),
  checkout: vi.fn(),
  subscriptions: vi.fn(),
  portal: vi.fn(),
}))
vi.mock("stripe", async (importOriginal) => {
  const actual = await importOriginal<typeof import("stripe")>()
  return {
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args)
        this.entitlements.activeEntitlements.list = provider.entitlements
        this.customers.create = provider.customer
        this.checkout.sessions.create = provider.checkout
        this.subscriptions.list = provider.subscriptions
        this.billingPortal.sessions.create = provider.portal
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
async function human(t: Test, email = "owner@example.com") {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Owner",
        email,
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
        token: `session-${email}`,
        expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  return {
    id: user._id as string,
    client: t.withIdentity({ subject: user._id, sessionId: session._id }),
  }
}
function stripeEvent(id: string, customer = "cus_test") {
  const body = JSON.stringify({
    id,
    object: "event",
    type: "entitlements.active_entitlement_summary.updated",
    livemode: false,
    created: Math.floor(Date.now() / 1000),
    data: { object: { customer, active_entitlements: [] } },
  })
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload: body,
    secret: "whsec_test",
  })
  return { body, signature }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_stripe")
  vi.stubEnv("STRIPE_PRICE_ID", "price_test")
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test")
  vi.stubEnv("SITE_URL", "http://localhost:3000")
  provider.entitlements.mockImplementation(async function* () {})
  provider.subscriptions.mockImplementation(async function* () {})
  provider.customer.mockResolvedValue({ id: "cus_test" })
  provider.checkout.mockResolvedValue({
    url: "https://checkout.stripe.com/test",
  })
  provider.portal.mockResolvedValue({ url: "https://billing.stripe.com/test" })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("Stripe payment authorization", () => {
  it("requires human login before managing legacy billing", async () => {
    const t = setup()
    await expect(t.action(api.stripe.checkout, {})).rejects.toThrow(
      "UNAUTHORIZED"
    )
    await expect(t.action(api.stripe.portal, {})).rejects.toThrow(
      "UNAUTHORIZED"
    )
    expect(provider.customer).not.toHaveBeenCalled()
  })

  it("reconciles signed entitlement updates and downgrades for an existing billing account", async () => {
    const t = setup()
    const owner = await human(t)
    expect(await owner.client.action(api.stripe.checkout, {})).toEqual({
      url: "https://checkout.stripe.com/test",
    })
    for (const [id, entitlements] of [
      ["evt_upgrade", ["higher_write_limits"]],
      ["evt_downgrade", []],
    ] as const) {
      provider.entitlements.mockImplementation(async function* () {
        for (const lookup_key of entitlements) yield { lookup_key }
      })
      const event = stripeEvent(id)
      const response = await t.fetch("/stripe/webhook", {
        method: "POST",
        headers: { "stripe-signature": event.signature },
        body: event.body,
      })
      expect(response.status).toBe(200)
      expect(
        (await owner.client.query(api.billing.current, {}))?.entitlements
      ).toEqual(entitlements)
    }
  })
  it("classifies provider outages and malformed checkout results without losing authentication", async () => {
    const t = setup()
    const owner = await human(t)
    provider.customer.mockRejectedValueOnce(
      Object.assign(new Error("private provider detail"), { statusCode: 503 })
    )
    await expect(owner.client.action(api.stripe.checkout, {})).rejects.toThrow(
      "UNAVAILABLE"
    )
    provider.checkout.mockResolvedValueOnce({ url: null })
    await expect(owner.client.action(api.stripe.checkout, {})).rejects.toThrow(
      "BAD_GATEWAY"
    )
  })

  it("keeps webhook verifier defects out of the authorization error channel", async () => {
    const t = setup()
    const event = stripeEvent("evt_defect")
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const verifier = vi
      .spyOn(Stripe.webhooks, "constructEvent")
      .mockImplementationOnce(() => {
        throw new Error("private verifier detail")
      })
    try {
      await expect(t.action(internal.stripe.webhook, event)).rejects.toThrow(
        "The request could not be completed."
      )
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "private verifier detail"
      )
      expect(provider.entitlements).not.toHaveBeenCalled()
    } finally {
      verifier.mockRestore()
      log.mockRestore()
    }
  })

  it("checks real webhook signatures before calling Stripe or modifying billing", async () => {
    const t = setup()
    const event = stripeEvent("evt_forged")
    const response = await t.fetch("/stripe/webhook", {
      method: "POST",
      headers: { "stripe-signature": event.signature },
      body: event.body.replace("cus_test", "cus_other"),
    })
    expect(response.status).toBe(400)
    expect(provider.entitlements).not.toHaveBeenCalled()
    expect(
      await t.run((ctx) => ctx.db.query("billingEvents").collect())
    ).toHaveLength(0)
  })

  it("does not reuse another account's customer or accept live billing credentials", async () => {
    const t = setup()
    const a = await human(t)
    const b = await human(t, "second@example.com")
    const first = await a.client.mutation(internal.billing.forCheckout, {})
    const second = await b.client.mutation(internal.billing.forCheckout, {})
    await t.mutation(internal.billing.attachCustomer, {
      accountId: first.id,
      customerId: "cus_test",
    })
    await expect(
      t.mutation(internal.billing.attachCustomer, {
        accountId: second.id,
        customerId: "cus_test",
      })
    ).rejects.toThrow("CONFLICT")
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_not_allowed")
    expect((await a.client.query(api.billing.current, {}))?.configured).toBe(
      false
    )
    await expect(a.client.action(api.stripe.checkout, {})).rejects.toThrow(
      "NOT_CONFIGURED"
    )
    expect(provider.checkout).not.toHaveBeenCalled()
  })

  it("shows test billing only when payment and webhook configuration is complete", async () => {
    const t = setup()
    const owner = await human(t)
    expect(
      (await owner.client.query(api.billing.current, {}))?.configured
    ).toBe(true)
    for (const variable of [
      "STRIPE_SECRET_KEY",
      "STRIPE_PRICE_ID",
      "STRIPE_WEBHOOK_SECRET",
      "SITE_URL",
    ] as const) {
      const configuredValue = process.env[variable]!
      vi.stubEnv(variable, "")
      expect(
        (await owner.client.query(api.billing.current, {}))?.configured,
        variable
      ).toBe(false)
      vi.stubEnv(variable, configuredValue)
    }
  })

  it("ignores duplicate events and prevents older reconciliations restoring removed access", async () => {
    const t = setup()
    const owner = await human(t)
    const account = await owner.client.mutation(
      internal.billing.forCheckout,
      {}
    )
    await t.mutation(internal.billing.attachCustomer, {
      accountId: account.id,
      customerId: "cus_test",
    })
    const older = (await t.mutation(internal.billing.beginSync, {
      customerId: "cus_test",
      eventId: "evt_old",
    }))!
    const newer = (await t.mutation(internal.billing.beginSync, {
      customerId: "cus_test",
      eventId: "evt_new",
    }))!
    await t.mutation(internal.billing.finishSync, {
      ...newer,
      customerId: "cus_test",
      eventId: "evt_new",
      entitlements: [],
    })
    expect(
      await t.mutation(internal.billing.finishSync, {
        ...older,
        customerId: "cus_test",
        eventId: "evt_old",
        entitlements: ["higher_write_limits"],
      })
    ).toBe(false)
    expect(
      await t.mutation(internal.billing.beginSync, {
        customerId: "cus_test",
        eventId: "evt_new",
      })
    ).toBeNull()
    expect(
      (await owner.client.query(api.billing.current, {}))?.entitlements
    ).toEqual([])
  })

  it("applies paid quotas to agent writes and returns to free quotas when entitlement is removed", async () => {
    const t = setup()
    const owner = await human(t)
    const token = "an_quota_fixture"
    const registered = await t.mutation(internal.agents.create, {
      input: {},
      hash: digest(token),
      prefix: "fixture",
    })
    const account = await owner.client.mutation(
      internal.billing.forCheckout,
      {}
    )
    // Existing quota-billing associations survive removal of the provider integration.
    await t.run((ctx) =>
      ctx.db.patch(registered.agentId, {
        ownerId: owner.id,
        billingAccountId: account.id,
      })
    )
    await t.run(async (ctx) => {
      await ctx.db.patch(account.id, { entitlements: ["higher_write_limits"] })
      await ctx.db.insert("limits", {
        bucket: `write:${registered.agentId}`,
        count: 60,
        resetAt: Date.now() + 60_000,
      })
    })
    await expect(
      t.mutation(internal.commands.execute, {
        token,
        operation: "profile",
        input: { bio: "Paid write" },
      })
    ).resolves.toBeDefined()
    await t.run((ctx) => ctx.db.patch(account.id, { entitlements: [] }))
    await expect(
      t.mutation(internal.commands.execute, {
        token,
        operation: "profile",
        input: { bio: "Free limit" },
      })
    ).rejects.toThrow("RATE_LIMITED")
  })
})
