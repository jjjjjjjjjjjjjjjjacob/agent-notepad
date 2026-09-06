/** Installed only into .artifacts/test-backend by scripts/place-load.ts. */
import { v } from "convex/values"
import {
  internalMutation,
  type MutationCtx,
} from "../../convex/_generated/server"
import type { Id } from "../../convex/_generated/dataModel"
import { executePlace } from "../../convex/place/commands"
import { ensureAllocation, journal } from "../../convex/place/money"
import { prepareChunk, activate, commit } from "../../convex/place/settlement"
import { scanOfferDependencies } from "../../convex/place/offers"
import {
  placeCommandSchemas,
  type PlaceOperation,
} from "../../lib/place-contracts"
import { ownershipReader, pixelRecord } from "../../convex/place/ownership"
import { internal } from "../../convex/_generated/api"
function guard() {
  if (
    process.env.SITE_URL !== "http://127.0.0.1:4242" ||
    (process.env.PLACE_MODE ?? "sandbox") !== "sandbox"
  )
    throw new Error("Isolated sandbox only")
}
function manual(ctx: MutationCtx): MutationCtx {
  return {
    ...ctx,
    scheduler: {
      runAfter: async () => "manual" as Id<"_scheduled_functions">,
      runAt: async () => "manual" as Id<"_scheduled_functions">,
      cancel: async () => {},
    },
  }
}
export const seed = internalMutation({
  args: { run: v.string() },
  handler: async (ctx, args) => {
    guard()
    const actors = []
    for (let i = 0; i < 33; i++) {
      const ownerId = `place-load-${args.run}-${i}`
      const id = await ctx.db.insert("agents", {
        name: `Sandbox painter ${i}`,
        slug: `place-load-${args.run}-${i}`,
        bio: "Isolated marketplace validation",
        capabilities: [],
        topics: [],
        role: "editor",
        blocked: false,
        ownerId,
        contributionCount: 0,
        reviewCount: 0,
        updatedAt: Date.now(),
      })
      const agent = (await ctx.db.get(id))!,
        funds = await ensureAllocation(ctx, agent),
        cents = i === 32 ? 2_000_000 : 100_000
      await ctx.db.patch(funds._id, { available: cents })
      await journal(
        ctx,
        `load-funding:${id}`,
        "isolated_fixture",
        [
          { account: "external:sandbox", cents: -cents },
          { account: `agent:${id}:available`, cents },
        ],
        [ownerId]
      )
      actors.push(id)
    }
    return actors
  },
})
export const command = internalMutation({
  args: { agentId: v.id("agents"), operation: v.string(), input: v.any() },
  handler: async (ctx, args) => {
    guard()
    if (!Object.hasOwn(placeCommandSchemas, args.operation))
      throw new Error("Invalid fixture operation")
    const agent = (await ctx.db.get(args.agentId))!
    const result = await executePlace(
      manual(ctx),
      agent,
      args.operation as PlaceOperation,
      args.input,
      crypto.randomUUID()
    )
    return { result, metrics: await ctx.meta.getTransactionMetrics() }
  },
})
export const step = internalMutation({
  args: { dealId: v.id("placeDeals") },
  handler: async (ctx, { dealId }) => {
    guard()
    const deal = (await ctx.db.get(dealId))!,
      isolated = manual(ctx)
    if (!["preparing", "settling"].includes(deal.status))
      return {
        status: deal.status,
        metrics: await ctx.meta.getTransactionMetrics(),
      }
    if (deal.preparedChunks < deal.chunkCount)
      await prepareChunk(isolated, deal)
    else if (deal.kind !== "initial" && !deal.conflictsReady)
      await scanOfferDependencies(isolated, deal)
    else if (deal.status === "preparing") await activate(isolated, deal)
    else await commit(isolated, deal)
    return {
      status: (await ctx.db.get(dealId))!.status,
      metrics: await ctx.meta.getTransactionMetrics(),
    }
  },
})
export const owners = internalMutation({
  args: { pixels: v.array(v.number()) },
  handler: async (ctx, { pixels }) => {
    guard()
    const reader = ownershipReader(ctx),
      owners = []
    for (const pixel of pixels)
      owners.push(
        (await reader.owner(await pixelRecord(ctx, pixel))).agentId ?? null
      )
    return owners
  },
})

// The human confirmation endpoint is tested separately with real auth contexts.
// This fixture starts at its persisted boundary to load-test inventory fanout.
export const banInventory = internalMutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, { agentId }) => {
    guard()
    const agent = (await ctx.db.get(agentId))!
    const banId = await ctx.db.insert("integrityBans", {
      agentId,
      ownerId: agent.ownerId,
      operatorId: "isolated-human-confirmation-fixture",
      reason:
        "Native inventory capacity test after simulated human confirmation.",
      evidence: ["isolated://place-load"],
      cutoff: Date.now(),
      phase: "revisions",
      nextAt: Date.now(),
    })
    await ctx.db.patch(agentId, {
      maliciousBanId: banId,
      placeEpoch: (agent.placeEpoch ?? 0) + 1,
      blocked: true,
    })
    await ctx.scheduler.runAfter(0, internal.integrityMaintenance.run, {
      banId,
    })
    return banId
  },
})
export const inventory = internalMutation({
  args: { banId: v.id("integrityBans"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    guard()
    const ban = (await ctx.db.get(args.banId))!
    const page = await ctx.db
      .query("placeForfeitures")
      .withIndex("by_ban_region", (q) => q.eq("banId", args.banId))
      .paginate({ cursor: args.cursor ?? null, numItems: 500 })
    return {
      phase: ban.phase,
      pixels: page.page.flatMap((lot) => lot.pixels),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
