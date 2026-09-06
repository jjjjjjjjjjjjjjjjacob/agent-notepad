import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { authComponent } from "../auth"
import { fail } from "../lib/core"
import { MAX_MONEY, money, SANDBOX_COSTS } from "../../lib/place"
import { digest, stableJson } from "../../lib/hash"
import { internal } from "../_generated/api"

export function sandboxOnly() {
  if (process.env.PLACE_MODE && process.env.PLACE_MODE !== "sandbox")
    fail(
      "NOT_CONFIGURED",
      "Live marketplace payments are disabled. A verified custody provider and live conformance checks are required."
    )
}
export function sellerLimit() {
  const configured = Number(process.env.PLACE_SANDBOX_MAX_SELLERS ?? 32)
  return Number.isInteger(configured) && configured > 0 && configured <= 128
    ? configured
    : 32
}
export const costs = () => SANDBOX_COSTS
export async function human(ctx: QueryCtx) {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user) fail("UNAUTHORIZED", "Sign in to manage your sandbox wallet.")
  return user._id
}
export function isOperator(ownerId: string) {
  return (process.env.PLACE_OPERATOR_OWNER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(ownerId)
}
export async function operator(ctx: QueryCtx) {
  const ownerId = await human(ctx)
  if (!isOperator(ownerId))
    fail(
      "FORBIDDEN",
      "This action requires an explicitly configured human operator."
    )
  return ownerId
}
export async function account(ctx: QueryCtx, ownerId: string) {
  return ctx.db
    .query("placeAccounts")
    .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
    .unique()
}
export async function ensureAccount(ctx: MutationCtx, ownerId: string) {
  const found = await account(ctx, ownerId)
  if (found) return found
  const id = await ctx.db.insert("placeAccounts", {
    ownerId,
    mode: "sandbox",
    currency: "USD",
    unallocated: 0,
    frozen: false,
    shortfall: 0,
    capacityVersion: 1,
    pendingCapacityCents: "0",
  })
  return (await ctx.db.get(id))!
}
/** Exact accounting also preserves legacy obligations already above MAX_MONEY. */
export function pendingCapacity(bank: Doc<"placeAccounts">) {
  if (bank.capacityVersion !== 1 || bank.pendingCapacityCents === undefined ||
      !/^\d+$/.test(bank.pendingCapacityCents))
    fail("CONFLICT", "Wallet capacity is being reconciled. Retry after migration completes.")
  return BigInt(bank.pendingCapacityCents)
}
export function assertPoolCredit(bank: Doc<"placeAccounts">, cents: number) {
  money(cents)
  if (BigInt(bank.unallocated) + pendingCapacity(bank) + BigInt(cents) > BigInt(MAX_MONEY))
    fail("CONFLICT", "Wallet capacity is reserved for pending deposits or withdrawal refunds.")
}
export function paymentCapacity(payment: Pick<Doc<"placePayments">, "kind" | "amountCents" | "feeCents">) {
  return money(payment.kind === "deposit" ? payment.amountCents :
    payment.kind === "withdrawal" ? payment.amountCents + payment.feeCents : 0)
}
export async function beginCapacityMigration(ctx: MutationCtx, bank: Doc<"placeAccounts">) {
  if (bank.capacityVersion === 1 || (bank.capacityNextAt ?? 0) > Date.now()) return
  await ctx.db.patch(bank._id, {
    ...(bank.capacityVersion === undefined ? { capacityVersion: 0 as const, pendingCapacityCents: "0", capacityCursor: undefined } : {}),
    capacityNextAt: Date.now() + 60_000,
  })
  await ctx.scheduler.runAfter(0, internal.placeWallet.migrateCapacity, { accountId: bank._id })
}
export async function allocation(ctx: QueryCtx, agentId: Id<"agents">) {
  return ctx.db
    .query("placeAllocations")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .unique()
}
export async function ensureAllocation(ctx: MutationCtx, agent: Doc<"agents">) {
  if (!agent.ownerId)
    fail(
      "FORBIDDEN",
      "A human must claim and fund this agent before it can trade."
    )
  const found = await allocation(ctx, agent._id)
  if (found) {
    if (found.ownerId !== agent.ownerId)
      fail(
        "FORBIDDEN",
        "The allocation does not belong to this agent's current human."
      )
    return found
  }
  await ensureAccount(ctx, agent.ownerId)
  const id = await ctx.db.insert("placeAllocations", {
    agentId: agent._id,
    ownerId: agent.ownerId,
    available: 0,
    reserved: 0,
    budgetManager: false,
  })
  return (await ctx.db.get(id))!
}
export async function eligible(
  ctx: QueryCtx,
  id: Id<"agents">,
  allowBlocked = false
) {
  const agent = await ctx.db.get(id)
  if (
    !agent ||
    !agent.ownerId ||
    agent.maliciousBanId ||
    (!allowBlocked && agent.blocked)
  )
    fail("FORBIDDEN", "A claimed, eligible agent is required.")
  if ((await account(ctx, agent.ownerId))?.frozen)
    fail("FORBIDDEN", "This funding account is frozen.")
  return agent as Doc<"agents"> & { ownerId: string }
}
export async function journal(
  ctx: MutationCtx,
  reference: string,
  kind: string,
  postings: { account: string; cents: number }[],
  ownerIds: string[]
) {
  if (
    postings.some((p) => !Number.isSafeInteger(p.cents)) ||
    postings.reduce((sum, p) => sum + BigInt(p.cents), BigInt(0)) !== BigInt(0)
  )
    fail("CONFLICT", "Unbalanced financial posting.")
  if (
    await ctx.db
      .query("placeLedger")
      .withIndex("by_reference", (q) => q.eq("reference", reference))
      .unique()
  )
    fail("CONFLICT", "Financial reference already posted.")
  await ctx.db.insert("placeLedger", {
    reference,
    kind,
    postings: postings.filter((p) => p.cents !== 0),
    ownerIds: [...new Set(ownerIds)],
  })
}
export async function reserve(
  ctx: MutationCtx,
  dealId: Id<"placeDeals">,
  agentId: Id<"agents">,
  cents: number
) {
  money(cents)
  const agent = await eligible(ctx, agentId)
  const funds = await ensureAllocation(ctx, agent)
  if (funds.available < cents)
    fail(
      "CONFLICT",
      "Insufficient unreserved funds in this agent's allocation."
    )
  const id = await ctx.db.insert("placeReservations", {
    dealId,
    agentId,
    ownerId: agent.ownerId,
    cents,
    status: "held",
  })
  await ctx.db.patch(funds._id, {
    available: funds.available - cents,
    reserved: money(funds.reserved + cents),
  })
  await journal(
    ctx,
    `reserve:${id}`,
    "reserve",
    [
      { account: `agent:${agentId}:available`, cents: -cents },
      { account: `agent:${agentId}:reserved`, cents },
    ],
    [agent.ownerId]
  )
  return id
}
export async function release(ctx: MutationCtx, id?: Id<"placeReservations">) {
  if (!id) return
  const hold = await ctx.db.get(id)
  if (!hold || hold.status !== "held") return
  const funds = await allocation(ctx, hold.agentId)
  if (!funds || funds.reserved < hold.cents)
    fail("CONFLICT", "Reservation ledger is inconsistent.")
  await ctx.db.patch(funds._id, {
    reserved: funds.reserved - hold.cents,
    available: money(funds.available + hold.cents),
  })
  await ctx.db.patch(hold._id, { status: "released" })
  await journal(
    ctx,
    `release:${id}`,
    "release",
    [
      { account: `agent:${hold.agentId}:reserved`, cents: -hold.cents },
      { account: `agent:${hold.agentId}:available`, cents: hold.cents },
    ],
    [hold.ownerId]
  )
}
export async function reallocate(
  ctx: MutationCtx,
  ownerId: string,
  targetId: Id<"agents">,
  cents: number,
  fromAgentId?: Id<"agents">
) {
  money(cents)
  if (cents < 1 || targetId === fromAgentId)
    fail("VALIDATION", "Choose distinct allocations and a positive amount.")
  const target = await eligible(ctx, targetId)
  if (target.ownerId !== ownerId)
    fail("FORBIDDEN", "Only agents belonging to this human can receive funds.")
  const destination = await ensureAllocation(ctx, target)
  const bank = await ensureAccount(ctx, ownerId)
  if (bank.frozen) fail("FORBIDDEN", "This funding account is frozen.")
  if (fromAgentId) {
    const source = await allocation(ctx, fromAgentId)
    if (!source || source.ownerId !== ownerId)
      fail("FORBIDDEN", "Source allocation belongs to another human.")
    if (source.available < cents)
      fail("CONFLICT", "Reserved funds cannot be reallocated.")
    await ctx.db.patch(source._id, { available: source.available - cents })
  } else {
    if (bank.unallocated < cents)
      fail("CONFLICT", "Insufficient unallocated funds.")
    await ctx.db.patch(bank._id, { unallocated: bank.unallocated - cents })
  }
  await ctx.db.patch(destination._id, {
    available: money(destination.available + cents),
  })
  return [
    {
      account: fromAgentId
        ? `agent:${fromAgentId}:available`
        : `human:${ownerId}:pool`,
      cents: -cents,
    },
    { account: `agent:${targetId}:available`, cents },
  ]
}
export async function humanReceipt(
  ctx: MutationCtx,
  ownerId: string,
  key: string,
  input: unknown
) {
  if (!key.trim() || key.length > 128)
    fail(
      "VALIDATION",
      "A stable idempotency key of 1–128 characters is required."
    )
  const fingerprint = digest(stableJson(input))
  const receipt = await ctx.db
    .query("placeHumanReceipts")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique()
  if (receipt && receipt.fingerprint !== fingerprint)
    fail("CONFLICT", "This idempotency key belongs to another request.")
  return { receipt, fingerprint }
}
