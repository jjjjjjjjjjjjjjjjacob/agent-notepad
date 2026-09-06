/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, components, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { MAX_MONEY } from "../lib/place"
import { sandboxProvider } from "../lib/place-provider"

const modules = import.meta.glob("../convex/**/*.ts")
function setup() { const t = convexTest(schema, modules); betterAuthTest.register(t); return t }
type Test = ReturnType<typeof setup>
let sequence = 0
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("PLACE_ENABLED", "true")
  vi.stubEnv("PLACE_MODE", "sandbox")
  vi.stubEnv("MODERATION_ENABLED", "false")
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllEnvs() })
async function human(t: Test) {
  const user = await t.mutation(components.betterAuth.adapter.create, { input: {
    model: "user", data: { name: "Capacity fixture", email: `capacity-${++sequence}@example.com`, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() },
  } })
  const session = await t.mutation(components.betterAuth.adapter.create, { input: {
    model: "session", data: { userId: user._id, token: `fixture-session-${sequence}`, expiresAt: Date.now() + 86400_000, createdAt: Date.now(), updatedAt: Date.now() },
  } })
  return { id: user._id as string, client: t.withIdentity({ subject: user._id, sessionId: session._id }) }
}
type Human = Awaited<ReturnType<typeof human>>
async function deposit(owner: Human, amountCents: number, idempotencyKey = `deposit-${++sequence}`) {
  const quote = sandboxProvider.quote("deposit", amountCents)
  return owner.client.mutation(api.placeWallet.manage, { operation: "deposit", amountCents, quotedFeeCents: quote.feeCents, idempotencyKey })
}
const paymentId = (result: { paymentId?: string }) => result.paymentId as Id<"placePayments">
const bank = (t: Test, owner: Human) => t.run(ctx => ctx.db.query("placeAccounts").withIndex("by_owner", q => q.eq("ownerId", owner.id)).unique())
async function fund(t: Test, owner: Human, cents: number) {
  const pending = await deposit(owner, cents)
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
}
async function event(t: Test, id: Id<"placePayments">, outcome: "succeeded" | "failed" = "succeeded") {
  const payment = (await t.run(ctx => ctx.db.get(id)))!
  return { eventId: `event-${++sequence}`, reference: payment.reference, amountCents: payment.amountCents,
    feeCents: payment.feeCents, outcome, mode: "sandbox" as const }
}
async function agent(t: Test, owner: Human) {
  return t.run(ctx => ctx.db.insert("agents", { name: "Capacity artist", slug: `capacity-artist-${++sequence}`,
    bio: "", capabilities: [], topics: [], role: "editor", blocked: false, ownerId: owner.id,
    contributionCount: 0, reviewCount: 0, updatedAt: Date.now() }))
}
async function balanced(t: Test) {
  for (const row of await t.run(ctx => ctx.db.query("placeLedger").collect()))
    expect(row.postings.reduce((sum, posting) => sum + BigInt(posting.cents), BigInt(0))).toBe(BigInt(0))
}

it("rejects aggregate pending deposits before creating excess obligations", async () => {
  const t = setup(), owner = await human(t)
  await deposit(owner, 600_000_000_000)
  await expect(deposit(owner, 600_000_000_000)).rejects.toThrow(/capacity/i)
  expect(await t.run(ctx => ctx.db.query("placePayments").collect())).toHaveLength(1)
})

it("parks a permanent credit-capacity failure instead of scheduling endless retries", async () => {
  const t = setup(), owner = await human(t), pending = await deposit(owner, 100)
  await t.run(async ctx => {
    const bank = await ctx.db.query("placeAccounts").withIndex("by_owner", q => q.eq("ownerId", owner.id)).unique()
    await ctx.db.patch(bank!._id, { unallocated: MAX_MONEY })
  })
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  expect((await t.run(ctx => ctx.db.get(paymentId(pending))))?.status).toBe("parked")
  expect((await owner.client.query(api.placeWallet.current, {})).unallocated).toBe(MAX_MONEY)
})

it("caps automatic attempts while retaining an uncertain payment obligation", async () => {
  const t = setup(), owner = await human(t), pending = await deposit(owner, 100)
  const provider = vi.spyOn(sandboxProvider, "reconcile").mockRejectedValue(new Error("provider unavailable"))
  for (let i = 0; i < 10; i++) {
    await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
    vi.setSystemTime(Date.now() + 3600_000)
  }
  expect(provider).toHaveBeenCalledTimes(8)
  expect((await t.run(ctx => ctx.db.get(paymentId(pending))))?.status).toBe("parked")
  expect((await t.run(ctx => ctx.db.query("placeLedger").collect()))).toHaveLength(0)
})

it("serializes deposit capacity reservations and keeps receipt/event retries idempotent", async () => {
  const t = setup(), owner = await human(t)
  const outcomes = await Promise.allSettled([deposit(owner, 600_000_000_000, "first"), deposit(owner, 600_000_000_000, "second")])
  expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1)
  const winner = outcomes.findIndex(result => result.status === "fulfilled")
  const accepted = outcomes[winner]
  if (accepted.status !== "fulfilled") throw new Error("Expected a reserved deposit")
  expect(await deposit(owner, 600_000_000_000, winner === 0 ? "first" : "second")).toEqual(accepted.value)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("600000000000")
  const callback = await event(t, paymentId(accepted.value))
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  expect((await bank(t, owner))?.unallocated).toBe(600_000_000_000)
  await balanced(t)
})

it("preserves failed-withdrawal refund capacity while new deposits are pending", async () => {
  const t = setup(), owner = await human(t)
  await fund(t, owner, 500_000_000_000)
  await fund(t, owner, 500_000_000_000)
  const withdrawal = await owner.client.mutation(api.placeWallet.manage, {
    operation: "withdrawal", amountCents: 100, quotedFeeCents: 25, idempotencyKey: "refund-room",
  })
  expect((await bank(t, owner))?.unallocated).toBe(MAX_MONEY - 125)
  await expect(deposit(owner, 100)).rejects.toThrow(/capacity/i)
  const callback = await event(t, paymentId(withdrawal), "failed")
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  expect((await bank(t, owner))?.unallocated).toBe(MAX_MONEY)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})

it("prevents allocation returns from consuming pending deposit capacity", async () => {
  const t = setup(), owner = await human(t), agentId = await agent(t, owner)
  await fund(t, owner, 1000)
  await owner.client.mutation(api.placeWallet.manage, { operation: "allocate", agentId, amountCents: 1000, idempotencyKey: "allocate" })
  const first = await deposit(owner, 500_000_000_000)
  await deposit(owner, 500_000_000_000)
  const request = { operation: "return_funds" as const, agentId, amountCents: 1000, idempotencyKey: "return" }
  await expect(owner.client.mutation(api.placeWallet.manage, request)).rejects.toThrow(/capacity/i)
  await t.mutation(internal.placeWallet.applyEvent, { event: await event(t, paymentId(first), "failed") })
  await owner.client.mutation(api.placeWallet.manage, request)
  expect((await bank(t, owner))?.unallocated).toBe(1000)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("500000000000")
  await balanced(t)
})

it("recovers transient uncertainty with bounded retries and no duplicate in-flight calls", async () => {
  const t = setup(), owner = await human(t), pending = await deposit(owner, 100)
  const original = sandboxProvider.reconcile.bind(sandboxProvider)
  const provider = vi.spyOn(sandboxProvider, "reconcile").mockImplementation(original).mockRejectedValueOnce(new Error("temporary failure"))
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  expect(provider).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 3000)
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  expect(provider).toHaveBeenCalledTimes(2)
  expect((await t.run(ctx => ctx.db.get(paymentId(pending))))?.status).toBe("succeeded")
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})

it("never refunds an exhausted uncertain withdrawal and accepts its later confirmed callback", async () => {
  const t = setup(), owner = await human(t)
  await fund(t, owner, 1000)
  const pending = await owner.client.mutation(api.placeWallet.manage, {
    operation: "withdrawal", amountCents: 500, quotedFeeCents: 25, idempotencyKey: "uncertain-withdrawal",
  })
  const provider = vi.spyOn(sandboxProvider, "reconcile").mockRejectedValue(new Error("uncertain provider result"))
  for (let i = 0; i < 10; i++) {
    await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
    vi.setSystemTime(Date.now() + 3600_000)
  }
  expect(provider).toHaveBeenCalledTimes(8)
  expect((await bank(t, owner))?.unallocated).toBe(475)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("525")
  const callback = await event(t, paymentId(pending), "failed")
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  await expect(t.mutation(internal.placeWallet.applyEvent, { event: { ...callback, outcome: "succeeded" } })).rejects.toThrow(/changed on replay/)
  expect((await bank(t, owner))?.unallocated).toBe(1000)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})

it("requires an operator to resume parked work and reuses the recorded provider outcome", async () => {
  const t = setup(), owner = await human(t), pending = await deposit(owner, 100), agentId = await agent(t, owner)
  const accountId = (await bank(t, owner))!._id
  await t.run(ctx => ctx.db.patch(accountId, { unallocated: MAX_MONEY }))
  const provider = vi.spyOn(sandboxProvider, "reconcile")
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  const request = { paymentId: paymentId(pending), idempotencyKey: "operator-reconcile" }
  await expect(owner.client.mutation(api.placeWallet.reconcilePayment, request)).rejects.toThrow(/operator/i)
  await expect(owner.client.query(api.placeWallet.reconciliationQueue, {})).rejects.toThrow(/operator/i)
  vi.stubEnv("PLACE_OPERATOR_OWNER_IDS", owner.id)
  expect((await owner.client.query(api.placeWallet.reconciliationQueue, {})).payments.map(row => row._id)).toEqual([paymentId(pending)])
  await owner.client.mutation(api.placeWallet.manage, { operation: "allocate", agentId, amountCents: 100, idempotencyKey: "free-room" })
  vi.stubEnv("PLACE_ENABLED", "false")
  const first = await owner.client.mutation(api.placeWallet.reconcilePayment, request)
  expect(await owner.client.mutation(api.placeWallet.reconcilePayment, request)).toEqual(first)
  await t.action(internal.placeWallet.process, { paymentId: paymentId(pending) })
  expect(provider).toHaveBeenCalledTimes(1)
  expect((await t.run(ctx => ctx.db.get(paymentId(pending))))?.status).toBe("succeeded")
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})

it("preserves overcommitted legacy totals exactly and releases only a confirmed obligation", async () => {
  const t = setup(), owner = await human(t)
  const fixtures = await t.run(async ctx => {
    const accountId = await ctx.db.insert("placeAccounts", { ownerId: owner.id, mode: "sandbox", currency: "USD", unallocated: 0, frozen: false, shortfall: 0 })
    const ids = []
    for (let n = 0; n < 2; n++) ids.push(await ctx.db.insert("placePayments", {
      ownerId: owner.id, kind: "deposit", amountCents: 600_000_000_000, feeCents: 17_400_000_030,
      status: "pending", reference: `legacy-large-${n}`, nextAt: Date.now(), attempts: 0,
    }))
    return { accountId, ids }
  })
  await t.mutation(internal.placeMaintenance.recover, {})
  expect((await bank(t, owner))?.capacityVersion).toBe(0)
  await t.mutation(internal.placeWallet.migrateCapacity, { accountId: fixtures.accountId })
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("1200000000000")
  await expect(deposit(owner, 100)).rejects.toThrow(/capacity/i)
  const callback = await event(t, fixtures.ids[0], "failed")
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("600000000000")
  await deposit(owner, 100)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("600000000100")
})

it("migrates all legacy obligations with a persisted bounded cursor before allowing credits", async () => {
  const t = setup(), owner = await human(t)
  const fixtures = await t.run(async ctx => {
    const accountId = await ctx.db.insert("placeAccounts", { ownerId: owner.id, mode: "sandbox", currency: "USD", unallocated: 200, frozen: false, shortfall: 0 })
    const pending = await ctx.db.insert("placePayments", { ownerId: owner.id, kind: "deposit", amountCents: 100, feeCents: 33, status: "pending", reference: "legacy-first", nextAt: Date.now(), attempts: 0 })
    for (let i = 0; i < 101; i++) await ctx.db.insert("placePayments", { ownerId: owner.id, kind: "deposit", amountCents: 100, feeCents: 33, status: "succeeded", reference: `legacy-terminal-${i}`, nextAt: Date.now(), attempts: 1 })
    const withdrawal = await ctx.db.insert("placePayments", { ownerId: owner.id, kind: "withdrawal", amountCents: 150, feeCents: 25, status: "pending", reference: "legacy-last", nextAt: Date.now(), attempts: 0 })
    return { accountId, pending, withdrawal }
  })
  const provider = vi.spyOn(sandboxProvider, "reconcile")
  await expect(deposit(owner, 100)).rejects.toThrow(/capacity/i)
  await t.action(internal.placeWallet.process, { paymentId: fixtures.pending })
  expect(provider).not.toHaveBeenCalled()
  await t.mutation(internal.placeWallet.migrateCapacity, { accountId: fixtures.accountId })
  expect((await bank(t, owner))?.capacityVersion).toBe(0)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("100")
  await expect(deposit(owner, 100)).rejects.toThrow(/capacity/i)
  await t.mutation(internal.placeWallet.migrateCapacity, { accountId: fixtures.accountId })
  expect((await bank(t, owner))?.capacityVersion).toBe(1)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("275")
  await t.mutation(internal.placeWallet.migrateCapacity, { accountId: fixtures.accountId })
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("275")
  await t.action(internal.placeWallet.process, { paymentId: fixtures.pending })
  await t.mutation(internal.placeWallet.applyEvent, { event: await event(t, fixtures.withdrawal, "failed") })
  expect((await bank(t, owner))?.unallocated).toBe(475)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})

it("records a late legacy callback during migration and never replaces its confirmed failed outcome", async () => {
  const t = setup(), owner = await human(t)
  const fixtures = await t.run(async ctx => ({
    accountId: await ctx.db.insert("placeAccounts", { ownerId: owner.id, mode: "sandbox", currency: "USD", unallocated: 475, frozen: false, shortfall: 0 }),
    paymentId: await ctx.db.insert("placePayments", { ownerId: owner.id, kind: "withdrawal", amountCents: 500, feeCents: 25, status: "processing", reference: "legacy-refund", nextAt: Date.now(), attempts: 1 }),
  }))
  const callback = await event(t, fixtures.paymentId, "failed")
  await t.mutation(internal.placeWallet.applyEvent, { event: callback })
  expect((await bank(t, owner))?.unallocated).toBe(475)
  await expect(t.mutation(internal.placeWallet.applyEvent, { event: { ...callback, outcome: "succeeded" } })).rejects.toThrow(/CONFLICT/)
  await t.mutation(internal.placeWallet.migrateCapacity, { accountId: fixtures.accountId })
  vi.stubEnv("PLACE_OPERATOR_OWNER_IDS", owner.id)
  await owner.client.mutation(api.placeWallet.reconcilePayment, { paymentId: fixtures.paymentId, idempotencyKey: "legacy-reconcile" })
  const provider = vi.spyOn(sandboxProvider, "reconcile")
  await t.action(internal.placeWallet.process, { paymentId: fixtures.paymentId })
  expect(provider).not.toHaveBeenCalled()
  expect((await bank(t, owner))?.unallocated).toBe(1000)
  expect((await bank(t, owner))?.pendingCapacityCents).toBe("0")
  await balanced(t)
})
