/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, components, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { digest } from "../lib/hash"
import { scopes } from "../lib/contracts"
import { placeCommandSchemas } from "../lib/place-contracts"
import {
  minimumResale,
  nextBid,
  PALETTE,
  qualifyingPrice,
  resaleFee,
  SANDBOX_COSTS,
  splitProceeds,
} from "../lib/place"
import { paymentSignature, verifyPaymentSignature } from "../lib/place-provider"

const modules = import.meta.glob("../convex/**/*.ts")
function setup() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
let sequence = 0
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("PLACE_ENABLED", "true")
  vi.stubEnv("PLACE_MODE", "sandbox")
  vi.stubEnv("MODERATION_ENABLED", "false")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
async function human(t: Test) {
  const email = `place-${++sequence}@example.com`
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Pixel funder",
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
        expiresAt: Date.now() + 86400_000,
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
async function actor(
  t: Test,
  owner?: Awaited<ReturnType<typeof human>>,
  funds = 100_000
) {
  owner ??= await human(t)
  const token = `an_place_${++sequence}`
  const id = await t.run(async (ctx) => {
    const agentId = await ctx.db.insert("agents", {
      name: `Artist ${sequence}`,
      slug: `artist-${sequence}`,
      bio: "",
      capabilities: [],
      topics: [],
      role: "editor",
      blocked: false,
      ownerId: owner.id,
      contributionCount: 0,
      reviewCount: 0,
      updatedAt: Date.now(),
    })
    await ctx.db.insert("keys", {
      agentId,
      hash: digest(token),
      prefix: token.slice(0, 11),
      scopes: [...scopes],
      label: "Tests",
    })
    return agentId
  })
  if (funds) {
    const quote = await owner.client.query(api.placeWallet.quote, {
      kind: "deposit",
      amountCents: funds,
    })
    const payment = await owner.client.mutation(api.placeWallet.manage, {
      operation: "deposit",
      amountCents: funds,
      quotedFeeCents: quote.feeCents,
      idempotencyKey: `fund-${id}`,
    })
    await t.action(internal.placeWallet.process, {
      paymentId: payment.paymentId as Id<"placePayments">,
    })
    await owner.client.mutation(api.placeWallet.manage, {
      operation: "allocate",
      agentId: id,
      amountCents: funds,
      idempotencyKey: `allocate-${id}`,
    })
  }
  return { id, token, owner }
}
type Actor = Awaited<ReturnType<typeof actor>>
async function command(
  t: Test,
  agent: Actor,
  operation: string,
  input: unknown,
  key = `command-${++sequence}`
) {
  return t.mutation(internal.commands.execute, {
    token: agent.token,
    operation,
    input,
    idempotencyKey: key,
  }) as Promise<Record<string, unknown>>
}
async function proposal(
  t: Test,
  agent: Actor,
  pixels: number[],
  kind: "initial" | "buy_now" | "auction" | "offer" | "transfer" = "initial",
  extra: Record<string, unknown> = {}
) {
  const draft = await command(t, agent, "place_create", {
    kind,
    title: "Test artwork",
    pixelCount: pixels.length,
    ...(kind === "initial" || kind === "transfer" ? {} : { priceCents: 1000 }),
    ...extra,
  })
  const dealId = draft.dealId as Id<"placeDeals">
  for (let i = 0; i < pixels.length; i += 500)
    await command(t, agent, "place_append", {
      dealId,
      pixels: pixels.slice(i, i + 500),
    })
  const sealed = await command(t, agent, "place_seal", { dealId })
  return { id: dealId, hash: sealed.termsHash as string }
}
async function advance(t: Test, id: Id<"placeDeals">) {
  for (let i = 0; i < 24; i++) {
    const deal = await t.run((ctx) => ctx.db.get(id))
    if (!deal || !["preparing", "settling"].includes(deal.status)) return deal
    await t.mutation(internal.placeMaintenance.advance, { dealId: id })
  }
  throw new Error("Deal failed to make bounded progress")
}
const wallet = (t: Test, agent: Actor) =>
  t.query(internal.place.wallet, { token: agent.token })
const approve = (
  t: Test,
  agent: Actor,
  deal: { id: Id<"placeDeals">; hash: string }
) =>
  command(t, agent, "place_approve", { dealId: deal.id, termsHash: deal.hash })

async function confirmBan(t: Test, subject: Actor) {
  const admin = await human(t)
  vi.stubEnv("PLACE_OPERATOR_OWNER_IDS", admin.id)
  const result = await admin.client.mutation(api.integrity.ban, {
    agentId: subject.id,
    reason: "Confirmed malicious conduct with preserved evidence.",
    evidence: ["https://example.com/evidence"],
    idempotencyKey: `ban-${subject.id}`,
  })
  return { admin, banId: result.banId as Id<"integrityBans"> }
}
async function fanout(t: Test, banId: Id<"integrityBans">) {
  for (let i = 0; i < 100; i++) {
    if ((await t.run((ctx) => ctx.db.get(banId)))?.phase === "complete") return
    await t.mutation(internal.integrityMaintenance.run, { banId })
  }
  throw new Error("Ban fanout did not finish")
}

describe("Place feature flag", () => {
  it("defaults off and blocks direct reads, agent commands, wallet operations, and receipt replays", async () => {
    const t = setup(),
      owner = await actor(t)
    const input = { kind: "initial", title: "Before disable", pixelCount: 1 }
    const draft = await command(
      t,
      owner,
      "place_create",
      input,
      "existing-receipt"
    )
    const payment = await t.run((ctx) => ctx.db.query("placePayments").first())
    vi.stubEnv("PLACE_ENABLED", undefined)
    for (const read of [
      () => t.query(api.place.config, {}),
      () => t.query(api.place.tiles, { tiles: [0] }),
      () => t.query(api.place.pixel, { pixel: 0 }),
      () => t.query(api.place.deal, { id: draft.dealId as string }),
      () =>
        t.query(api.place.market, {
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      () =>
        t.query(api.place.history, {
          paginationOpts: { cursor: null, numItems: 10 },
        }),
      () =>
        t.query(api.place.portfolio, {
          agentId: owner.id,
          after: -1,
          limit: 10,
        }),
      () => wallet(t, owner),
      () => owner.owner.client.query(api.placeWallet.current, {}),
      () =>
        owner.owner.client.query(api.placeWallet.quote, {
          kind: "deposit",
          amountCents: 1000,
        }),
    ])
      await expect(read()).rejects.toThrow("Place is not enabled.")
    for (const operation of Object.keys(placeCommandSchemas).filter((name) =>
      name.startsWith("place_")
    )) {
      await expect(command(t, owner, operation, {})).rejects.toThrow(
        "Place is not enabled."
      )
    }
    await expect(
      command(t, owner, "place_create", input, "existing-receipt")
    ).rejects.toThrow("Place is not enabled.")
    for (const operation of [
      "deposit",
      "withdrawal",
      "allocate",
      "return_funds",
      "budget_manager",
    ] as const) {
      await expect(
        owner.owner.client.mutation(api.placeWallet.manage, {
          operation,
          agentId: owner.id,
          amountCents: 1000,
          enabled: true,
          idempotencyKey: operation,
        })
      ).rejects.toThrow("Place is not enabled.")
    }
    await expect(
      owner.owner.client.mutation(api.placeWallet.reverseDeposit, {
        paymentId: payment!._id,
        idempotencyKey: "disabled-reversal",
      })
    ).rejects.toThrow("Place is not enabled.")
    await expect(
      owner.owner.client.mutation(api.integrity.grantAuctioneer, {
        agentId: owner.id,
        enabled: true,
        idempotencyKey: "disabled-grant",
      })
    ).rejects.toThrow("Place is not enabled.")
    vi.stubEnv("PLACE_ENABLED", "true")
    expect((await wallet(t, owner)).availableCents).toBe(100_000)
    expect(
      await command(t, owner, "place_create", input, "existing-receipt")
    ).toEqual(draft)
  })

  it("continues accepted settlement, expiry, cleanup, and provider reconciliation while disabled", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t)
    await advance(t, (await proposal(t, seller, [70, 71])).id)
    const auction = await proposal(t, seller, [70], "auction", {
      durationMs: 300_000,
    })
    await approve(t, seller, auction)
    const active = await advance(t, auction.id)
    await command(t, buyer, "place_bid", {
      dealId: auction.id,
      amountCents: 1000,
    })
    const offer = await proposal(t, buyer, [71], "offer", {
      durationMs: 300_000,
    })
    const purchase = await proposal(t, buyer, [72])
    const quote = await buyer.owner.client.query(api.placeWallet.quote, {
      kind: "deposit",
      amountCents: 1000,
    })
    const payment = await buyer.owner.client.mutation(api.placeWallet.manage, {
      operation: "deposit",
      amountCents: 1000,
      quotedFeeCents: quote.feeCents,
      idempotencyKey: "pending-deposit",
    })
    vi.stubEnv("PLACE_ENABLED", "false")
    expect((await advance(t, purchase.id))?.status).toBe("committed")
    await t.action(internal.placeWallet.process, {
      paymentId: payment.paymentId as Id<"placePayments">,
    })
    vi.setSystemTime(active!.expiresAt!)
    await t.mutation(internal.placeMaintenance.advance, { dealId: offer.id })
    await t.mutation(internal.placeMaintenance.advance, { dealId: auction.id })
    expect((await advance(t, auction.id))?.status).toBe("committed")
    for (const dealId of [purchase.id, offer.id, auction.id]) {
      await t.mutation(internal.placeMaintenance.cleanup, { dealId })
      await t.mutation(internal.placeMaintenance.invalidateOffers, { dealId })
    }
    expect((await t.run((ctx) => ctx.db.get(offer.id)))?.status).toBe("expired")
    expect(
      (
        await t.run((ctx) =>
          ctx.db.get(payment.paymentId as Id<"placePayments">)
        )
      )?.status
    ).toBe("succeeded")
    vi.stubEnv("PLACE_ENABLED", "true")
    expect((await wallet(t, buyer)).reservedCents).toBe(0)
    expect(
      (await buyer.owner.client.query(api.placeWallet.current, {})).unallocated
    ).toBe(1000)
    expect((await t.query(api.place.pixel, { pixel: 70 })).owner?.id).toBe(
      buyer.id
    )
    expect((await t.query(api.place.pixel, { pixel: 72 })).owner?.id).toBe(
      buyer.id
    )
  })

  it("blocks new forfeiture auctions while preserving conduct enforcement", async () => {
    const t = setup(),
      seller = await actor(t)
    await advance(t, (await proposal(t, seller, [80])).id)
    vi.stubEnv("PLACE_ENABLED", "false")
    const { admin, banId } = await confirmBan(t, seller)
    await fanout(t, banId)
    const lot = await t.run((ctx) => ctx.db.query("placeForfeitures").first())
    expect(lot?.pixels).toEqual([80])
    await expect(
      admin.client.mutation(api.integrity.auctionLot, {
        lotId: lot!._id,
        title: "Disabled auction",
        priceCents: 1000,
        durationMs: 300_000,
        idempotencyKey: "disabled-lot",
      })
    ).rejects.toThrow("Place is not enabled.")
  })
  it("rejects unsupported-mode forfeiture auctions before receipts or scheduling", async () => {
    const t = setup(),
      seller = await actor(t)
    await advance(t, (await proposal(t, seller, [81])).id)
    const { admin, banId } = await confirmBan(t, seller)
    await fanout(t, banId)
    const lot = await t.run((ctx) => ctx.db.query("placeForfeitures").first())
    const before = await t.run(async (ctx) => ({
      deals: (await ctx.db.query("placeDeals").collect()).length,
      receipts: (await ctx.db.query("placeHumanReceipts").collect()).length,
      scheduled: (await ctx.db.system.query("_scheduled_functions").collect())
        .length,
    }))
    vi.stubEnv("PLACE_MODE", "live")
    await expect(
      admin.client.mutation(api.integrity.auctionLot, {
        lotId: lot!._id,
        title: "Unsupported auction",
        priceCents: 1000,
        durationMs: 300_000,
        idempotencyKey: "unsupported-lot",
      })
    ).rejects.toThrow(/disabled/)
    expect(
      await t.run(async (ctx) => ({
        deals: (await ctx.db.query("placeDeals").collect()).length,
        receipts: (await ctx.db.query("placeHumanReceipts").collect()).length,
        scheduled: (await ctx.db.system.query("_scheduled_functions").collect())
          .length,
      }))
    ).toEqual(before)
    vi.stubEnv("PLACE_MODE", "sandbox")
    const request = {
      lotId: lot!._id,
      title: "Supported auction",
      priceCents: 1000,
      durationMs: 300_000,
      idempotencyKey: "supported-lot",
    }
    const created = await admin.client.mutation(
      api.integrity.auctionLot,
      request
    )
    expect(
      await admin.client.mutation(api.integrity.auctionLot, request)
    ).toEqual(created)
    vi.stubEnv("PLACE_MODE", "live")
    await expect(
      admin.client.mutation(api.integrity.auctionLot, request)
    ).rejects.toThrow(/disabled/)
  })
})

describe("market recovery and conduct", () => {
  it("lets a seller withdraw until the final purchase commit and serializes that withdrawal against settlement", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t)
    await advance(t, (await proposal(t, seller, [610])).id)
    const listing = await proposal(t, seller, [610], "buy_now")
    await approve(t, seller, listing)
    await advance(t, listing.id)
    await command(t, buyer, "place_buy", {
      dealId: listing.id,
      termsHash: listing.hash,
    })
    await command(t, seller, "place_cancel", { dealId: listing.id })
    await t.mutation(internal.placeMaintenance.advance, { dealId: listing.id })
    expect((await t.query(api.place.pixel, { pixel: 610 })).owner?.id).toBe(
      seller.id
    )
    expect((await wallet(t, buyer)).reservedCents).toBe(0)
    const offer = await proposal(t, buyer, [610], "offer")
    await approve(t, seller, offer)
    await expect(
      command(t, buyer, "place_cancel", { dealId: offer.id })
    ).rejects.toThrow(/binding/)
    for (let i = 0; i < 2; i++)
      await t.mutation(internal.placeMaintenance.advance, { dealId: offer.id })
    await Promise.allSettled([
      command(t, seller, "place_cancel", { dealId: offer.id }),
      t.mutation(internal.placeMaintenance.advance, { dealId: offer.id }),
    ])
    const result = (await t.run((ctx) => ctx.db.get(offer.id)))!
    expect(["cancelled", "committed"]).toContain(result.status)
    expect((await t.query(api.place.pixel, { pixel: 610 })).owner?.id).toBe(
      result.status === "committed" ? buyer.id : seller.id
    )
    expect((await wallet(t, buyer)).reservedCents).toBe(0)
  })
  it("preserves negotiated shares through repeated splitting and rebundling", async () => {
    const t = setup(),
      a = await actor(t),
      b = await actor(t),
      c = await actor(t)
    const pixels = [31, 32, 33, 34]
    await advance(t, (await proposal(t, a, pixels)).id)
    for (let round = 0; round < 3; round++) {
      const left = await proposal(t, b, pixels.slice(0, 2), "offer"),
        right = await proposal(t, c, pixels.slice(2), "offer")
      await approve(t, a, left)
      await advance(t, left.id)
      await approve(t, a, right)
      await advance(t, right.id)
      const draft = await command(t, a, "place_create", {
        kind: "offer",
        title: "Negotiated reunion",
        pixelCount: 4,
        priceCents: 3333,
      })
      const id = draft.dealId as Id<"placeDeals">
      await command(t, a, "place_append", { dealId: id, pixels })
      const sealed = await command(t, a, "place_seal", {
        dealId: id,
        shares: [
          { agentId: b.id, weight: 1 },
          { agentId: c.id, weight: 2 },
        ],
      })
      const bundle = { id, hash: sealed.termsHash as string }
      const beforeB = (await wallet(t, b)).availableCents,
        beforeC = (await wallet(t, c)).availableCents
      await approve(t, b, bundle)
      await approve(t, c, bundle)
      await advance(t, id)
      expect((await wallet(t, b)).availableCents - beforeB).toBe(1000)
      expect((await wallet(t, c)).availableCents - beforeC).toBe(2000)
      for (const pixel of pixels)
        expect((await t.query(api.place.pixel, { pixel })).owner?.id).toBe(a.id)
    }
  })
  it("refunds a failed external withdrawal exactly once", async () => {
    const t = setup(),
      a = await actor(t)
    await a.owner.client.mutation(api.placeWallet.manage, {
      operation: "return_funds",
      agentId: a.id,
      amountCents: 1000,
      idempotencyKey: "return-for-withdrawal",
    })
    const requested = await a.owner.client.mutation(api.placeWallet.manage, {
      operation: "withdrawal",
      amountCents: 500,
      quotedFeeCents: 25,
      idempotencyKey: "failed-withdrawal",
    })
    const payment = (await t.run((ctx) =>
      ctx.db.get(requested.paymentId as Id<"placePayments">)
    ))!
    const event = {
      eventId: "provider-failure",
      reference: payment.reference,
      amountCents: 500,
      feeCents: 25,
      outcome: "failed" as const,
      mode: "sandbox" as const,
    }
    await t.mutation(internal.placeWallet.applyEvent, { event })
    await t.mutation(internal.placeWallet.applyEvent, { event })
    expect(
      (await a.owner.client.query(api.placeWallet.current, {})).unallocated
    ).toBe(1000)
    await expect(
      t.mutation(internal.placeWallet.applyEvent, {
        event: { ...event, amountCents: 501 },
      })
    ).rejects.toThrow(/changed on replay/)
  })
  it("keeps funded auction commitments binding through an ordinary block", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t)
    await advance(t, (await proposal(t, seller, [809])).id)
    const auction = await proposal(t, seller, [809], "auction", {
      durationMs: 300000,
    })
    await approve(t, seller, auction)
    const live = await advance(t, auction.id)
    await command(t, buyer, "place_bid", {
      dealId: auction.id,
      amountCents: 1000,
    })
    await t.run((ctx) => ctx.db.patch(buyer.id, { blocked: true }))
    vi.setSystemTime(live!.expiresAt!)
    await t.mutation(internal.placeMaintenance.advance, { dealId: auction.id })
    await advance(t, auction.id)
    expect((await t.query(api.place.pixel, { pixel: 809 })).owner?.id).toBe(
      buyer.id
    )
  })
  it("rejects new bids after the seller or highest bidder is banned, before cancellation fanout", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t),
      challenger = await actor(t)
    await advance(t, (await proposal(t, seller, [810])).id)
    const auction = await proposal(t, seller, [810], "auction")
    await approve(t, seller, auction)
    await advance(t, auction.id)
    await command(t, buyer, "place_bid", {
      dealId: auction.id,
      amountCents: 1000,
    })
    await confirmBan(t, buyer)
    await expect(
      command(t, challenger, "place_bid", {
        dealId: auction.id,
        amountCents: 2000,
      })
    ).rejects.toThrow(/highest bidder was banned/)
    expect((await wallet(t, challenger)).reservedCents).toBe(0)
  })
  it("invalidates overlapping offers at the commit marker, then recovers reserved funds", async () => {
    const t = setup(),
      seller = await actor(t),
      a = await actor(t),
      b = await actor(t)
    await advance(t, (await proposal(t, seller, [800, 801])).id)
    const stale = await proposal(t, a, [800, 801], "offer"),
      accepted = await proposal(t, b, [801], "offer")
    await approve(t, seller, accepted)
    await advance(t, accepted.id)
    expect((await t.query(api.place.deal, { id: stale.id })).status).toBe(
      "cancelled"
    )
    await expect(approve(t, seller, stale)).rejects.toThrow(/changed ownership/)
    expect((await wallet(t, a)).reservedCents).toBe(1000)
    await t.mutation(internal.placeMaintenance.invalidateOffers, {
      dealId: accepted.id,
    })
    expect((await wallet(t, a)).reservedCents).toBe(0)
    expect((await t.query(api.place.pixel, { pixel: 800 })).owner?.id).toBe(
      seller.id
    )
  })
  it("expires offers exactly on time, cancels no-bid auctions, and restores canceled reservations", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t)
    await advance(t, (await proposal(t, seller, [900])).id)
    const offer = await proposal(t, buyer, [900], "offer", {
      durationMs: 300000,
    })
    vi.setSystemTime(Date.now() + 300000)
    await expect(approve(t, seller, offer)).rejects.toThrow(
      /cannot be approved/
    )
    await t.mutation(internal.placeMaintenance.advance, { dealId: offer.id })
    expect((await wallet(t, buyer)).reservedCents).toBe(0)
    const auction = await proposal(t, seller, [900], "auction", {
      durationMs: 300000,
    })
    await approve(t, seller, auction)
    const active = await advance(t, auction.id)
    await expect(proposal(t, buyer, [900], "offer")).rejects.toThrow(
      /exclusively/
    )
    vi.setSystemTime(active!.expiresAt!)
    await t.mutation(internal.placeMaintenance.advance, { dealId: auction.id })
    expect((await t.query(api.place.pixel, { pixel: 900 })).owner?.id).toBe(
      seller.id
    )
    expect((await t.run((ctx) => ctx.db.get(auction.id)))?.status).toBe(
      "expired"
    )
  })
  it("allows free sibling transfers with immediate ownership and no platform fee", async () => {
    const t = setup(),
      seller = await actor(t),
      sibling = await actor(t, seller.owner, 0)
    await advance(t, (await proposal(t, seller, [990])).id)
    const transfer = await proposal(t, seller, [990], "transfer", {
      buyerId: sibling.id,
    })
    await approve(t, seller, transfer)
    expect((await advance(t, transfer.id))?.status).toBe("committed")
    expect((await t.query(api.place.pixel, { pixel: 990 })).owner?.id).toBe(
      sibling.id
    )
    const trade = await t.run((ctx) =>
      ctx.db
        .query("placeTrades")
        .withIndex("by_deal", (q) => q.eq("dealId", transfer.id))
        .unique()
    )
    expect(trade?.feeCents).toBe(0)
  })
  it("recovers available funds after a reversal without reversing downstream pixel ownership", async () => {
    const t = setup(),
      a = await actor(t),
      b = await actor(t)
    await advance(t, (await proposal(t, a, [998])).id)
    const offer = await proposal(t, b, [998], "offer")
    await approve(t, a, offer)
    await advance(t, offer.id)
    vi.stubEnv("PLACE_OPERATOR_OWNER_IDS", b.owner.id)
    const payment = await t.run((ctx) =>
      ctx.db
        .query("placePayments")
        .withIndex("by_owner", (q) => q.eq("ownerId", b.owner.id))
        .first()
    )
    await b.owner.client.mutation(api.placeWallet.reverseDeposit, {
      paymentId: payment!._id,
      idempotencyKey: "reverse-deposit",
    })
    await t.mutation(internal.placeMaintenance.frozenAccount, {
      ownerId: b.owner.id,
      phase: "allocations",
    })
    const bank = await b.owner.client.query(api.placeWallet.current, {})
    expect(bank.frozen).toBe(true)
    expect(bank.shortfall).toBe(1000)
    await command(t, b, "place_paint", { pixels: [{ pixel: 998, color: 13 }] })
    expect((await t.query(api.place.pixel, { pixel: 998 })).color).toBe(13)
    expect((await t.query(api.place.pixel, { pixel: 998 })).owner?.id).toBe(
      b.id
    )
    expect((await wallet(t, a)).availableCents).toBe(100800)
  })
  it("forfeits both normalized and pending ownership, preserving colors and paying the original human", async () => {
    const t = setup(),
      seller = await actor(t),
      buyer = await actor(t)
    const purchase = await proposal(t, seller, [0, 1, 999999])
    await advance(t, purchase.id)
    await command(t, seller, "place_paint", {
      pixels: [{ pixel: 0, color: 5 }],
    })
    const auction = await proposal(t, seller, [0, 1], "auction")
    await approve(t, seller, auction)
    await advance(t, auction.id)
    await command(t, buyer, "place_bid", {
      dealId: auction.id,
      amountCents: 1000,
    })
    const { admin, banId } = await confirmBan(t, seller)
    expect((await t.query(api.place.pixel, { pixel: 999999 })).custody).toBe(
      "forfeiture"
    )
    await expect(
      command(t, seller, "place_paint", { pixels: [{ pixel: 0, color: 7 }] })
    ).rejects.toThrow()
    await fanout(t, banId)
    await fanout(t, banId)
    expect((await wallet(t, buyer)).reservedCents).toBe(0)
    const lots = await t.run((ctx) =>
      ctx.db.query("placeForfeitures").collect()
    )
    expect(
      lots
        .map((l) => l.pixels)
        .flat()
        .sort((a, b) => a - b)
    ).toEqual([0, 1, 999999])
    expect((await t.run((ctx) => ctx.db.get(purchase.id)))?.status).toBe(
      "committed"
    )
    const lot = lots.find((l) => l.region === 0)!
    const scheduled = await admin.client.mutation(api.integrity.auctionLot, {
      lotId: lot._id,
      title: "Recovered artwork",
      priceCents: 1000,
      durationMs: 300000,
      idempotencyKey: "lot-auction",
    })
    const dealId = scheduled.dealId as Id<"placeDeals">
    await advance(t, dealId)
    await command(t, buyer, "place_bid", { dealId, amountCents: 1000 })
    vi.setSystemTime(Date.now() + 300000)
    await t.mutation(internal.placeMaintenance.advance, { dealId })
    await advance(t, dealId)
    expect((await t.query(api.place.pixel, { pixel: 0 })).owner?.id).toBe(
      buyer.id
    )
    expect((await t.query(api.place.pixel, { pixel: 0 })).color).toBe(5)
    expect(
      (
        await seller.owner.client.query(api.placeWallet.current, {})
      ).allocations.find((a) => a.agentId === seller.id)?.available
    ).toBe(100600)
  })
  it("ordinary blocks preserve ownership and do not create forfeiture cases", async () => {
    const t = setup(),
      a = await actor(t)
    await advance(t, (await proposal(t, a, [599])).id)
    await t.run((ctx) => ctx.db.patch(a.id, { blocked: true }))
    expect((await t.query(api.place.pixel, { pixel: 599 })).owner?.id).toBe(
      a.id
    )
    expect(
      await t.run((ctx) => ctx.db.query("integrityBans").collect())
    ).toEqual([])
  })
})

describe("human-supervised integrity review", () => {
  it("keeps posts, notes and messages unavailable without a safe predecessor, and merges pre-ban review tasks", async () => {
    const t = setup(),
      bad = await actor(t),
      reviewer = await actor(t),
      admin = await human(t)
    vi.stubEnv("PLACE_OPERATOR_OWNER_IDS", admin.id)
    const ids: Id<"resources">[] = []
    for (const kind of ["post", "note", "message"] as const) {
      const resourceId = await t.run(async (ctx) => {
        const id = await ctx.db.insert("resources", {
          kind,
          slug: `unsafe-${kind}`,
          title: "Flagged original",
          excerpt: "Flagged original",
          authorId: bad.id,
          topic: "integrity",
          score: 0,
          rank: 0,
          commentCount: 0,
          disputed: false,
          suppressed: false,
          protection: "open",
          updatedAt: Date.now(),
        })
        const rev = await ctx.db.insert("revisions", {
          resourceId: id,
          authorId: bad.id,
          title: "Flagged original",
          body: "Preserved untrusted original",
          summary: "Original",
          citations: [],
          attachmentIds: [],
          status: "published",
          suppressed: false,
        })
        await ctx.db.patch(id, {
          currentRevisionId: rev,
          latestRevisionId: rev,
        })
        return id
      })
      ids.push(resourceId)
      await admin.client.mutation(api.integrity.flag, {
        resourceId,
        agentId: bad.id,
        reason: "Confirmed instruction injection with original evidence.",
        idempotencyKey: `pre-ban-${kind}`,
      })
      expect(
        await t.query(api.public.getResource, { slugOrId: resourceId })
      ).toBeNull()
      expect(
        (await t.query(api.integrity.publicStatus, { slugOrId: resourceId }))
          ?.unavailable
      ).toBe(true)
    }
    const before = await t.run((ctx) =>
      ctx.db.query("integrityReviews").collect()
    )
    const { banId } = await confirmBan(t, bad)
    await fanout(t, banId)
    const after = await t.run((ctx) =>
      ctx.db.query("integrityReviews").collect()
    )
    expect(after).toHaveLength(3)
    expect(after.map((r) => r.taskId).sort()).toEqual(
      before.map((r) => r.taskId).sort()
    )
    for (const review of after) {
      expect(review.banId).toBe(banId)
      const evidence = await t.query(internal.integrity.evidence, {
        token: reviewer.token,
        reviewId: review._id,
        limit: 16,
      })
      expect(evidence.ban?.evidence).toEqual(["https://example.com/evidence"])
      expect(evidence.current?.body).toBe("Preserved untrusted original")
    }
    const lease = await command(t, reviewer, "request_work", {
      types: ["integrity_review"],
    })
    expect(lease.status).toBe("active")
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("notices")
          .withIndex("by_agent", (q) => q.eq("agentId", reviewer.id))
          .collect()
      )
    ).not.toHaveLength(0)
  })
  it("deduplicates review fanout, keeps later edits visible, preserves evidence and applies fallback across public reads", async () => {
    const t = setup(),
      original = await actor(t),
      bad = await actor(t),
      later = await actor(t)
    const resourceId = await t.run((ctx) =>
      ctx.db.insert("resources", {
        kind: "wiki",
        slug: "reviewed-place",
        title: "Original",
        excerpt: "Original",
        authorId: original.id,
        topic: "art",
        score: 0,
        rank: 0,
        commentCount: 0,
        disputed: false,
        suppressed: false,
        protection: "open",
        updatedAt: Date.now(),
      })
    )
    const revision = async (author: Actor, body: string) =>
      t.run(async (ctx) => {
        const item = (await ctx.db.get(resourceId))!
        const id = await ctx.db.insert("revisions", {
          resourceId,
          authorId: author.id,
          title: body,
          body,
          summary: body,
          citations: [],
          attachmentIds: [],
          status: "published",
          suppressed: false,
          ...(item.currentRevisionId
            ? { parentRevisionId: item.currentRevisionId }
            : {}),
        })
        await ctx.db.patch(resourceId, {
          currentRevisionId: id,
          latestRevisionId: id,
          title: body,
          excerpt: body,
        })
        return id
      })
    const first = await revision(original, "Original safe body")
    vi.setSystemTime(Date.now() + 10)
    const implicated = await revision(bad, "Malicious contribution")
    vi.setSystemTime(Date.now() + 10)
    const latest = await revision(
      later,
      "Later edits retained for investigation"
    )
    const { admin, banId } = await confirmBan(t, bad)
    await fanout(t, banId)
    const reviews = await t.run((ctx) =>
      ctx.db.query("integrityReviews").collect()
    )
    expect(reviews).toHaveLength(1)
    expect(
      (await t.query(api.public.getResource, { slugOrId: resourceId }))
        ?.revision.id
    ).toBe(latest)
    await admin.client.mutation(api.integrity.flag, {
      resourceId,
      agentId: bad.id,
      reason: "Confirmed instruction injection in preserved revision.",
      idempotencyKey: "flag",
    })
    expect(
      (await t.query(api.public.getResource, { slugOrId: resourceId }))
        ?.revision.id
    ).toBe(first)
    expect(
      await t.query(api.public.getResource, {
        slugOrId: resourceId,
        revisionId: implicated,
      })
    ).toBeNull()
    const history = await t.query(api.public.history, {
      resourceId,
      paginationOpts: { numItems: 30, cursor: null },
    })
    expect(history.items.map((r) => r.id)).toEqual([first])
    expect((await t.run((ctx) => ctx.db.get(implicated)))?.body).toBe(
      "Malicious contribution"
    )
    const evidence = await t.query(internal.integrity.evidence, {
      token: later.token,
      reviewId: reviews[0]._id,
      limit: 16,
    })
    expect(evidence.current?._id).toBe(latest)
    const lease = await command(t, later, "request_work", {
      types: ["integrity_review"],
    })
    const report = await command(t, later, "submit_work", {
      assignmentId: lease._id,
      report: "Reviewed the original and all intervening revisions.",
      verdict: "checked",
      log: "Inspected complete preserved revision chain.",
      evidence: [],
      inspectedRevisionId: latest,
    })
    expect(
      (await t.query(api.public.getResource, { slugOrId: resourceId }))
        ?.revision.id
    ).toBe(first)
    await expect(
      admin.client.mutation(api.integrity.resolve, {
        reviewId: reviews[0]._id,
        reportId: report.reportId as Id<"reports">,
        inspectedRevisionId: implicated,
        applyCorrection: false,
        reason: "Attempted stale report approval.",
        idempotencyKey: "stale",
      })
    ).rejects.toThrow(/exact current/)
    await admin.client.mutation(api.integrity.resolve, {
      reviewId: reviews[0]._id,
      reportId: report.reportId as Id<"reports">,
      inspectedRevisionId: latest,
      applyCorrection: false,
      reason: "Human verified restoration after the complete inspection.",
      idempotencyKey: "resolve",
    })
    expect(
      (await t.query(api.public.getResource, { slugOrId: resourceId }))
        ?.revision.id
    ).toBe(latest)
    expect((await t.run((ctx) => ctx.db.get(reviews[0].taskId!)))?.status).toBe(
      "completed"
    )
  })
})

describe("pixel economics", () => {
  it("uses the original fixed palette and conservative profitable cent floors", () => {
    expect(PALETTE).toHaveLength(16)
    expect(PALETTE[0]).toBe("#FFFFFF")
    expect(PALETTE[15]).toBe("#820080")
    for (const recipients of [1, 2, 32]) {
      const floor = minimumResale(recipients, SANDBOX_COSTS)!
      for (let cents = floor; cents < floor + 2000; cents++)
        expect(qualifyingPrice(cents, recipients, SANDBOX_COSTS)).toBe(true)
    }
    expect(minimumResale(1, { ...SANDBOX_COSTS, variableBps: 800 })).toBeNull()
    expect(minimumResale(1, { ...SANDBOX_COSTS, verified: false })).toBeNull()
    expect(nextBid(101)).toBe(103)
    expect(resaleFee(105)).toBe(11)
  })
  it("allocates every cent deterministically, including fractional negotiated shares", () => {
    expect(
      splitProceeds(10, [
        { agentId: "b", weight: 1 },
        { agentId: "a", weight: 1 },
        { agentId: "c", weight: 1 },
      ])
    ).toEqual([
      { agentId: "b", cents: 3 },
      { agentId: "a", cents: 4 },
      { agentId: "c", cents: 3 },
    ])
    for (let amount = 0; amount < 150; amount++)
      expect(
        splitProceeds(amount, [
          { agentId: "a", weight: 37 },
          { agentId: "b", weight: 21 },
        ]).reduce((s, p) => s + p.cents, 0)
      ).toBe(amount)
    expect(
      verifyPaymentSignature(
        "body",
        paymentSignature("body", "secret"),
        "secret"
      )
    ).toBe(true)
    expect(
      verifyPaymentSignature(
        "changed",
        paymentSignature("body", "secret"),
        "secret"
      )
    ).toBe(false)
  })
})
describe("sandbox funding and marketplace", () => {
  it("requires idempotency, rejects live mode, and does not double-credit duplicate provider callbacks", async () => {
    const t = setup(),
      a = await actor(t)
    await expect(
      t.mutation(internal.commands.execute, {
        token: a.token,
        operation: "place_create",
        input: { kind: "initial", title: "x", pixelCount: 1 },
      })
    ).rejects.toThrow(/Idempotency/)
    const rows = await t.run((ctx) => ctx.db.query("placePayments").collect())
    await t.action(internal.placeWallet.process, { paymentId: rows[0]._id })
    expect((await wallet(t, a)).availableCents).toBe(100_000)
    const first = await command(
      t,
      a,
      "place_create",
      { kind: "initial", title: "x", pixelCount: 1 },
      "stable"
    )
    expect(
      await command(
        t,
        a,
        "place_create",
        { kind: "initial", title: "x", pixelCount: 1 },
        "stable"
      )
    ).toEqual(first)
    await expect(
      command(
        t,
        a,
        "place_create",
        { kind: "initial", title: "changed", pixelCount: 1 },
        "stable"
      )
    ).rejects.toThrow(/different request/)
    vi.stubEnv("PLACE_MODE", "live")
    await expect(
      command(t, a, "place_create", {
        kind: "initial",
        title: "x",
        pixelCount: 1,
      })
    ).rejects.toThrow(/disabled/)
  })
  it("serializes competing initial buyers and authorizes painting immediately at commitment", async () => {
    const t = setup(),
      a = await actor(t),
      b = await actor(t)
    const first = await proposal(t, a, [0, 1]),
      second = await proposal(t, b, [0, 1])
    const results = await Promise.all([
      advance(t, first.id),
      advance(t, second.id),
    ])
    expect(results.map((r) => r!.status).sort()).toEqual([
      "committed",
      "failed",
    ])
    const winner = results[0]?.status === "committed" ? a : b,
      loser = winner === a ? b : a
    expect((await t.query(api.place.pixel, { pixel: 0 })).owner?.id).toBe(
      winner.id
    )
    expect(
      (
        await t.query(api.place.portfolio, {
          agentId: winner.id,
          after: -1,
          limit: 50,
        })
      ).items
    ).toHaveLength(2)
    await command(t, winner, "place_paint", {
      pixels: [{ pixel: 0, color: 5 }],
    })
    await expect(
      command(t, loser, "place_paint", { pixels: [{ pixel: 0, color: 1 }] })
    ).rejects.toThrow(/do not own/)
    expect((await t.query(api.place.pixel, { pixel: 0 })).color).toBe(5)
    expect((await wallet(t, loser)).reservedCents).toBe(0)
  })
  it("keeps full offer backing and settles multi-seller approvals with negotiated shares", async () => {
    const t = setup(),
      a = await actor(t),
      b = await actor(t),
      buyer = await actor(t)
    await advance(t, (await proposal(t, a, [10])).id)
    await advance(t, (await proposal(t, b, [11])).id)
    const offer = await proposal(t, buyer, [10, 11], "offer", {
      priceCents: 1010,
    })
    expect((await wallet(t, buyer)).reservedCents).toBe(1010)
    await approve(t, a, offer)
    expect((await t.run((ctx) => ctx.db.get(offer.id)))?.status).toBe("active")
    await approve(t, b, offer)
    expect((await advance(t, offer.id))?.status).toBe("committed")
    expect((await wallet(t, buyer)).availableCents).toBe(98_990)
    const sellers = await Promise.all([wallet(t, a), wallet(t, b)])
    expect(sellers.reduce((n, w) => n + w.availableCents, 0)).toBe(
      199_800 + 909
    )
    const rows = await t.run((ctx) => ctx.db.query("placeLedger").collect())
    for (const row of rows)
      expect(row.postings.reduce((n, p) => n + p.cents, 0)).toBe(0)
  })
  it("resets every approval when terms change and prevents self-trading across a shared human", async () => {
    const t = setup(),
      a = await actor(t),
      sibling = await actor(t, a.owner),
      buyer = await actor(t)
    await advance(t, (await proposal(t, a, [100])).id)
    const listing = await proposal(t, a, [100], "buy_now")
    const changed = await command(t, a, "place_terms", {
      dealId: listing.id,
      priceCents: 1500,
    })
    await expect(approve(t, a, listing)).rejects.toThrow(/exact current terms/)
    listing.hash = changed.termsHash as string
    await approve(t, a, listing)
    await advance(t, listing.id)
    await expect(
      command(t, sibling, "place_buy", {
        dealId: listing.id,
        termsHash: listing.hash,
      })
    ).rejects.toThrow(/same human/)
    await command(t, buyer, "place_buy", {
      dealId: listing.id,
      termsHash: listing.hash,
    })
    await advance(t, listing.id)
    expect(
      (await command(t, a, "place_cancel", { dealId: listing.id })).status
    ).toBe("committed")
    expect((await t.query(api.place.pixel, { pixel: 100 })).owner?.id).toBe(
      buyer.id
    )
  })
  it("extends late auctions, refunds outbids, rejects retraction, and closes against authoritative time", async () => {
    const t = setup(),
      a = await actor(t),
      b = await actor(t),
      c = await actor(t)
    await advance(t, (await proposal(t, a, [200])).id)
    const listing = await proposal(t, a, [200], "auction", {
      durationMs: 300_000,
    })
    await approve(t, a, listing)
    const live = await advance(t, listing.id)
    const oldEnd = live!.expiresAt!
    await command(t, b, "place_bid", { dealId: listing.id, amountCents: 1000 })
    await expect(
      command(t, a, "place_cancel", { dealId: listing.id })
    ).rejects.toThrow(/binding/)
    vi.setSystemTime(oldEnd - 10_000)
    const bid = await command(t, c, "place_bid", {
      dealId: listing.id,
      amountCents: 1010,
    })
    expect(bid.expiresAt).toBe(oldEnd + 50_000)
    expect((await wallet(t, b)).reservedCents).toBe(0)
    vi.setSystemTime(Number(bid.expiresAt))
    await expect(
      command(t, b, "place_bid", { dealId: listing.id, amountCents: 2000 })
    ).rejects.toThrow(/closed/)
    await t.mutation(internal.placeMaintenance.advance, { dealId: listing.id })
    await advance(t, listing.id)
    expect((await t.query(api.place.pixel, { pixel: 200 })).owner?.id).toBe(
      c.id
    )
  })
  it("requires explicit manager authority and never reallocates reserved commitments", async () => {
    const t = setup(),
      a = await actor(t),
      sibling = await actor(t, a.owner, 0),
      seller = await actor(t)
    await advance(t, (await proposal(t, seller, [400])).id)
    await proposal(t, a, [400], "offer", { priceCents: 99_999 })
    await expect(
      command(t, a, "place_allocate", {
        agentId: sibling.id,
        fromAgentId: a.id,
        amountCents: 1,
      })
    ).rejects.toThrow(/budget-manager/)
    await a.owner.client.mutation(api.placeWallet.manage, {
      operation: "budget_manager",
      agentId: a.id,
      enabled: true,
      idempotencyKey: "grant",
    })
    await command(t, a, "place_allocate", {
      agentId: sibling.id,
      fromAgentId: a.id,
      amountCents: 1,
    })
    await expect(
      command(t, a, "place_allocate", {
        agentId: sibling.id,
        fromAgentId: a.id,
        amountCents: 1,
      })
    ).rejects.toThrow(/Reserved funds/)
  })
  it("commits 10,000 scattered pixels without exposing partial ownership and supports later subset sales", async () => {
    const t = setup(),
      a = await actor(t, undefined, 2_000_000),
      b = await actor(t)
    const pixels = Array.from({ length: 10_000 }, (_, i) => i * 100)
    const acquisition = await proposal(t, a, pixels)
    for (let i = 0; i < 20; i++)
      await t.mutation(internal.placeMaintenance.advance, {
        dealId: acquisition.id,
      })
    expect((await t.query(api.place.pixel, { pixel: 0 })).owner).toBeNull()
    expect((await t.query(api.place.pixel, { pixel: 999900 })).owner).toBeNull()
    await t.mutation(internal.placeMaintenance.advance, {
      dealId: acquisition.id,
    })
    expect((await t.query(api.place.pixel, { pixel: 0 })).owner?.id).toBe(a.id)
    expect((await t.query(api.place.pixel, { pixel: 999900 })).owner?.id).toBe(
      a.id
    )
    const offer = await proposal(t, b, [0, 999900], "offer")
    await approve(t, a, offer)
    await advance(t, offer.id)
    expect((await t.query(api.place.pixel, { pixel: 999900 })).owner?.id).toBe(
      b.id
    )
    expect((await t.query(api.place.pixel, { pixel: 100 })).owner?.id).toBe(
      a.id
    )
  }, 120_000)
})
