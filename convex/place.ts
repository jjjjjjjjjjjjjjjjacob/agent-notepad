import { requirePlaceEnabled } from "./place/access"
import { offerAvailability } from "./place/offers"
import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { internalQuery, query } from "./_generated/server"
import type { QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { asId, fail, requireAgent } from "./lib/core"

import { account, allocation, costs, sellerLimit } from "./place/money"
import {
  auction,
  getDeal,
  ownershipReader,
  pixelRecord,
  terminal,
} from "./place/ownership"
import {
  PALETTE,
  PLACE_SIZE,
  TILE_SIZE,
  INITIAL_PIXEL_CENTS,
  MAX_BUNDLE_PIXELS,
  MAX_PAINT_PIXELS,
  minimumResale,
  tileAddress,
} from "../lib/place"

async function agentView(ctx: QueryCtx, id: Id<"agents">) {
  const agent = await ctx.db.get(id)
  return {
    id,
    name: agent?.quarantined
      ? "Profile under review"
      : (agent?.name ?? "Unknown agent"),
    slug: agent?.slug ?? "",
    maliciousBanId: agent?.maliciousBanId ?? null,
  }
}
// Bound aggregate seller and offer-dependency reads below the transaction budget.
const viewLimit = () => Math.min(50, Math.floor(2800 / (sellerLimit() + 70)))
export const configuration = () => ({
  mode: "sandbox" as const,
  liveEnabled: false,
  currency: "USD",
  width: PLACE_SIZE,
  height: PLACE_SIZE,
  tileSize: TILE_SIZE,
  palette: PALETTE,
  initialPixelCents: INITIAL_PIXEL_CENTS,
  feeBps: 1000,
  maxBundlePixels: MAX_BUNDLE_PIXELS,
  maxSellers: sellerLimit(),
  maxPaintPixels: MAX_PAINT_PIXELS,
  minimumResaleCents: minimumResale(1, costs()),
  settlementCosts: costs(),
  notice:
    "Sandbox only. Funds and proceeds have no monetary value. Real payments are disabled.",
})
export const config = query({
  args: {},
  handler: () => {
    requirePlaceEnabled()
    return configuration()
  },
})
export const tiles = query({
  args: { tiles: v.array(v.number()) },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    if (
      args.tiles.length > 25 ||
      args.tiles.some((t) => !Number.isInteger(t) || t < 0 || t >= 400)
    )
      fail("VALIDATION", "Request at most 25 tile IDs from 0 to 399.")
    return Promise.all(
      [...new Set(args.tiles)].map(async (tile) => {
        const row = await ctx.db
          .query("placeTiles")
          .withIndex("by_tile", (q) => q.eq("tile", tile))
          .unique()
        return {
          tile,
          colors: row?.colors ?? new Uint8Array(2500).buffer,
          updatedAt: row?.updatedAt ?? 0,
        }
      })
    )
  },
})
export async function dealView(ctx: QueryCtx, deal: Doc<"placeDeals">) {
  const sellers = await Promise.all(
    deal.sellers.map(async (s) => ({
      agent: await agentView(ctx, s.agentId),
      pixels: s.count,
      weight: s.weight,
      approved: s.approved,
    }))
  )
  const buyer = deal.buyerId ? await agentView(ctx, deal.buyerId) : null
  const invalidParticipant =
    deal.sellers.some(
      (s, i) => deal.kind !== "forfeiture" && sellers[i].agent.maliciousBanId
    ) || buyer?.maliciousBanId
  const availability =
    deal.kind === "offer" && !terminal(deal.status)
      ? await offerAvailability(ctx, deal._id)
      : { available: true, invalid: false }
  const elapsed = deal.expiresAt !== undefined && deal.expiresAt <= Date.now()
  return {
    id: deal._id,
    title: deal.title,
    kind: deal.kind,
    status: availability.invalid
      ? "cancelled"
      : !availability.available
        ? "reserved"
        : !terminal(deal.status) && invalidParticipant
          ? "cancelled"
          : deal.status === "active" && elapsed
            ? auction(deal) && deal.bidCount
              ? "settling"
              : "expired"
            : deal.status,
    pixelCount: deal.pixelCount,
    appended: deal.appended,
    chunks: deal.chunkCount,
    priceCents: deal.priceCents,
    minimumCents: deal.minimumCents,
    feeCents: deal.feeCents ?? null,
    termsHash: deal.termsHash ?? null,
    sellers,
    buyer,
    bidCount: deal.bidCount,
    expiresAt: deal.expiresAt ?? null,
    durationMs: deal.durationMs,
    preparedChunks: deal.preparedChunks,
    committedAt: deal.committedAt ?? null,
    error: deal.error ?? null,
    createdAt: deal._creationTime,
    mode: "sandbox" as const,
  }
}
export const deal = query({
  args: { id: v.string(), chunk: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    const item = await getDeal(ctx, asId(ctx, "placeDeals", args.id))
    const ordinal = args.chunk ?? 0
    if (!Number.isInteger(ordinal) || ordinal < 0 || ordinal >= 20)
      fail("VALIDATION", "Chunk must be from 0 to 19.")
    const manifest = await ctx.db
      .query("placeManifests")
      .withIndex("by_deal_ordinal", (q) =>
        q.eq("dealId", item._id).eq("ordinal", ordinal)
      )
      .unique()
    const bids = await ctx.db
      .query("placeBids")
      .withIndex("by_deal", (q) => q.eq("dealId", item._id))
      .order("desc")
      .take(20)
    const view = await dealView(ctx, item)
    const reader = ownershipReader(ctx)
    let valid = true
    if (manifest && item.kind === "offer" && item.status === "active")
      for (const entry of manifest.entries) {
        if (
          (await reader.owner(await pixelRecord(ctx, entry.pixel))).version !==
          entry.version
        ) {
          valid = false
          break
        }
      }
    return {
      ...view,
      status: valid ? view.status : "cancelled",
      manifest: manifest
        ? {
            ordinal,
            entries: manifest.entries,
            nextChunk: ordinal + 1 < item.chunkCount ? ordinal + 1 : null,
            ownershipValidForThisChunk: valid,
          }
        : null,
      bids,
    }
  },
})
export const pixel = query({
  args: { pixel: v.number() },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    if (!Number.isInteger(args.pixel) || args.pixel < 0 || args.pixel > 999999)
      fail("VALIDATION", "Pixel ID must be from 0 through 999999.")
    const owner = await ownershipReader(ctx).owner(
      await pixelRecord(ctx, args.pixel)
    )
    const { tile, offset } = tileAddress(args.pixel)
    const colors = await ctx.db
      .query("placeTiles")
      .withIndex("by_tile", (q) => q.eq("tile", tile))
      .unique()
    const memberships = await ctx.db
      .query("placeMemberships")
      .withIndex("by_pixel", (q) => q.eq("pixel", args.pixel))
      .order("desc")
      .take(viewLimit())
    const deals = [],
      trades = []
    for (const member of memberships) {
      const listing = await ctx.db.get(member.dealId)
      if (!listing) continue
      if (listing.status === "active" && member.version === owner.version) {
        const view = await dealView(ctx, listing)
        if (view.status === "active") deals.push(view)
      }
      if (listing.status === "committed") {
        const trade = await ctx.db
          .query("placeTrades")
          .withIndex("by_deal", (q) => q.eq("dealId", listing._id))
          .unique()
        if (trade) trades.push(trade)
      }
    }
    return {
      pixel: args.pixel,
      x: args.pixel % 1000,
      y: Math.floor(args.pixel / 1000),
      color: colors ? new Uint8Array(colors.colors)[offset] : 0,
      owner: owner.agentId ? await agentView(ctx, owner.agentId) : null,
      custody: owner.banId ? "forfeiture" : owner.agentId ? "agent" : "unowned",
      banId: owner.banId ?? null,
      version: owner.version,
      deals,
      trades,
      historyTruncated: memberships.length === viewLimit(),
    }
  },
})
export const market = query({
  args: {
    kind: v.optional(
      v.union(
        v.literal("buy_now"),
        v.literal("auction"),
        v.literal("offer"),
        v.literal("forfeiture")
      )
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    const base = args.kind
      ? ctx.db
          .query("placeDeals")
          .withIndex("by_kind_status", (q) =>
            q.eq("kind", args.kind!).eq("status", "active")
          )
      : ctx.db
          .query("placeDeals")
          .withIndex("by_status_next", (q) => q.eq("status", "active"))
    const page = await base.order("desc").paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, viewLimit()),
    })
    const items = []
    for (const entry of page.page) {
      const view = await dealView(ctx, entry)
      if (view.status === "active") items.push(view)
    }
    return { items, cursor: page.isDone ? null : page.continueCursor }
  },
})
export const history = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    const page = await ctx.db
      .query("placeTrades")
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    return {
      items: page.page,
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const portfolio = query({
  args: { agentId: v.id("agents"), after: v.number(), limit: v.number() },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    if (
      !Number.isInteger(args.after) ||
      args.after < -1 ||
      args.after > 999999 ||
      !Number.isInteger(args.limit) ||
      args.limit < 1 ||
      args.limit > 100
    )
      fail("VALIDATION", "Invalid portfolio page.")
    const [base, pending] = await Promise.all([
      ctx.db
        .query("placePixels")
        .withIndex("by_owner_pixel", (q) =>
          q.eq("ownerId", args.agentId).gt("pixel", args.after)
        )
        .take(args.limit),
      ctx.db
        .query("placePixels")
        .withIndex("by_buyer_pixel", (q) =>
          q.eq("prospectiveBuyer", args.agentId).gt("pixel", args.after)
        )
        .take(args.limit),
    ])
    const through = Math.min(
      base.length === args.limit ? base[base.length - 1].pixel : 999999,
      pending.length === args.limit ? pending[pending.length - 1].pixel : 999999
    )
    const candidates = [
      ...new Map([...base, ...pending].map((p) => [p.pixel, p])).values(),
    ]
      .filter((p) => p.pixel <= through)
      .sort((a, b) => a.pixel - b.pixel)
    const reader = ownershipReader(ctx),
      items: { pixel: number; version: string }[] = []
    let after = args.after
    for (const pixel of candidates) {
      after = pixel.pixel
      const owner = await reader.owner(pixel)
      if (owner.agentId === args.agentId)
        items.push({ pixel: pixel.pixel, version: owner.version })
      if (items.length >= args.limit) break
    }
    return {
      items,
      after:
        candidates.length &&
        (base.length === args.limit ||
          pending.length === args.limit ||
          after < candidates[candidates.length - 1].pixel)
          ? after
          : null,
    }
  },
})
export const wallet = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, args) => {
    requirePlaceEnabled()
    const { agent } = await requireAgent(ctx, args.token)
    const funds = await allocation(ctx, agent._id)
    const bank = agent.ownerId ? await account(ctx, agent.ownerId) : null
    return {
      mode: "sandbox" as const,
      liveEnabled: false,
      claimed: !!agent.ownerId,
      availableCents: funds?.available ?? 0,
      reservedCents: funds?.reserved ?? 0,
      budgetManager: funds?.budgetManager ?? false,
      frozen: bank?.frozen ?? false,
    }
  },
})
