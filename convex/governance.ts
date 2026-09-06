import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { DAY, committeeSize, voteWeight } from "../lib/moderation-policy"
import {
  agentRestricted,
  approvedOwner,
  observe,
  principalRestricted,
} from "./moderation/access"
import { fillSeats, closeRound, releaseSeats, queueRound, escalateRound } from "./moderation/rounds"
import { moderationReads, ModerationCapacityExceeded, juryScore, MAX_CANDIDATES } from "./moderation/authorship"
import { cancelAgentWork } from "./moderation/sanctions"
import { openQualityCase } from "./moderation/cases"
import { recomputeCommunity, reverseSource } from "./moderation/reputation"
import { indexResource, metric } from "./lib/core"
import { startRetention, retireEvidencePage } from "./governanceRetention"

export const freezeRoster = internalMutation({
  args: {},
  handler: async (ctx) => {
    const day = Math.floor(Date.now() / DAY)
    if (
      await ctx.db
        .query("juryEpochs")
        .withIndex("by_day", (q) => q.eq("day", day))
        .unique()
    )
      return
    const reads = moderationReads(ctx)
    const roster: { ownerId: string; agentId: import("./_generated/dataModel").Id<"agents">; reputation: number; weight: number }[] = []
    try {
    for (const nomination of await reads.rows(ctx.db.query("juryNominations"), MAX_CANDIDATES)) {
      if (!nomination.available || nomination.effectiveDay > day) continue
      const agent = await reads.get(nomination.agentId)
      if (
        !agent ||
        agent.ownerId !== nomination.ownerId ||
        agent._creationTime > Date.now() - 14 * DAY ||
        !(await approvedOwner(ctx, nomination.ownerId)) ||
        (await agentRestricted(ctx, agent))
      )
        continue
      const score = await juryScore(reads, agent._id)
      if (score < 10) continue
      roster.push({
        ownerId: nomination.ownerId,
        agentId: agent._id,
        reputation: score,
        weight: voteWeight(score),
      })
    }
    } catch (error) {
      if (!(error instanceof ModerationCapacityExceeded)) throw error
      await ctx.db.insert("juryEpochs", { day, frozenAt: Date.now(), state: "saturated" })
      return
    }
    // Install only a fully evaluated population. No partial roster may bias the
    // uniform draw when an owner or the total operation saturates its budget.
    for (const row of roster) await ctx.db.insert("juryRoster", { day, ...row })
    await ctx.db.insert("juryEpochs", { day, frozenAt: Date.now(), state: "complete" })
  },
})
export const drawCandidates = internalQuery({
  args: { caseId: v.id("moderationCases") },
  handler: async (ctx, { caseId }) => {
    const c = await ctx.db.get(caseId)
    if (!c || c.state !== "queued") return null
    const epoch = await ctx.db.query("juryEpochs").withIndex("by_day", q => q.eq("day", c.rosterDay)).unique()
    if (!epoch || epoch.state === "saturated" || c.authorshipState === "incomplete") return { saturated: true, candidates: [] }
    let roster
    try { roster = await moderationReads(ctx).rows(ctx.db
      .query("juryRoster")
      .withIndex("by_day", (q) => q.eq("day", c.rosterDay)), MAX_CANDIDATES) }
    catch (error) { if (!(error instanceof ModerationCapacityExceeded)) throw error; return { saturated: true, candidates: [] } }
    return { saturated: false, candidates: roster
      .filter(
        (r) =>
          !c.excludedOwners.includes(r.ownerId) &&
          !c.excludedAgents.includes(r.agentId)
      )
      .map(({ agentId, ownerId, weight }) => ({ agentId, ownerId, weight })) }
  },
})
export const installDraw = internalMutation({
  args: {
    caseId: v.id("moderationCases"),
    seed: v.string(),
    saturated: v.optional(v.boolean()),
    candidates: v.array(
      v.object({
        agentId: v.id("agents"),
        ownerId: v.string(),
        weight: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    const c = await ctx.db.get(args.caseId)
    if (!c || c.state !== "queued") return
    // Only this internal mutation can install a draw. An action retry cannot reroll it.
    const state =
      args.saturated || c.authorshipState === "incomplete" || args.candidates.length > MAX_CANDIDATES ||
      new Set(args.candidates.map(candidate => candidate.ownerId)).size !== args.candidates.length ||
      new Set(args.candidates.map(candidate => candidate.agentId)).size !== args.candidates.length ||
      args.candidates.length < committeeSize(c.kind) ||
      Date.now() >= c.seatingUntil
        ? "escalated"
        : "seating"
    await ctx.db.patch(c._id, {
      candidates: args.candidates.length <= MAX_CANDIDATES ? args.candidates : [],
      drawSeed: args.seed,
      state,
      ...(state === "escalated"
        ? {
            decisionReason:
              "The complete frozen roster could not be evaluated safely or does not contain enough independent jurors.",
          }
        : {}),
    })
    if (state === "seating") await fillSeats(ctx, (await ctx.db.get(c._id))!)
  },
})
export const quality = internalMutation({
  args: {
    kind: v.union(v.literal("article_quality"), v.literal("task_quality")),
    targetId: v.string(),
  },
  handler: async (ctx, args) => {
    await openQualityCase(ctx, args.kind, args.targetId)
  },
})
export const recover = internalMutation({
  args: { state: v.optional(v.string()), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const state = (args.state ?? "queued") as "queued" | "seating" | "voting"
    if (!["queued", "seating", "voting"].includes(state)) return
    const page = await ctx.db
      .query("moderationCases")
      .withIndex("by_state", (q) => q.eq("state", state))
      .paginate({ cursor: args.cursor ?? null, numItems: 30 })
    for (const c of page.page) {
      if (state === "queued") {
        if (Date.now() >= c.seatingUntil)
          await ctx.db.patch(c._id, {
            state: "escalated",
            decisionReason:
              "The roster could not be drawn before the seating deadline. Human review is required.",
          })
        else
          await ctx.scheduler.runAfter(0, internal.committee.draw, {
            caseId: c._id,
          })
      } else await queueRound(ctx, c)
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.governance.recover, {
        state,
        cursor: page.continueCursor,
      })
    else if (state !== "voting")
      await ctx.scheduler.runAfter(0, internal.governance.recover, {
        state: state === "queued" ? "seating" : "voting",
      })
  },
})
// Each round gets a fresh transaction and one pending continuation. Stale work
// observes current state; it cannot reopen a resolved case or reroll a draw.
export const continueCase = internalMutation({
  args: { caseId: v.id("moderationCases"), generation: v.number() },
  handler: async (ctx, { caseId, generation }) => {
    const c = await ctx.db.get(caseId)
    if (!c?.roundJobPending || c.roundJobVersion !== generation) return
    await ctx.db.patch(c._id, { roundJobPending: false })
    if (c.state === "seating") await fillSeats(ctx, c)
    else if (c.state === "voting") {
      if (Date.now() > c.deadline + 2 * 60000) await escalateRound(ctx, c,
        "Automatic closure did not complete by the deadline. Human review is required without lowering the thresholds.")
      else await closeRound(ctx, c)
    }
  },
})
export const releaseCaseSeats = internalMutation({
  args: { caseId: v.id("moderationCases"), cursor: v.string() },
  handler: async (ctx, { caseId, cursor }) => {
    const c = await ctx.db.get(caseId)
    if (c && ["resolved", "escalated"].includes(c.state)) await releaseSeats(ctx, c, cursor)
  },
})
export const cancelOwnerWork = internalMutation({
  args: { ownerId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) => q.eq("ownerId", args.ownerId))
      .paginate({ cursor: args.cursor ?? null, numItems: 32 })
    for (const agent of page.page) await cancelAgentWork(ctx, agent._id)
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.governance.cancelOwnerWork, {
        ownerId: args.ownerId,
        cursor: page.continueCursor,
      })
  },
})
export const reindex = internalMutation({
  args: { resourceId: v.id("resources") },
  handler: async (ctx, { resourceId }) => {
    const resource = await ctx.db.get(resourceId),
      rev = resource?.currentRevisionId
        ? await ctx.db.get(resource.currentRevisionId)
        : null
    if (
      resource &&
      rev &&
      !resource.suppressed &&
      !resource.quarantined &&
      !rev.suppressed &&
      !rev.quarantined
    )
      await indexResource(ctx, resource, rev)
  },
})
export const maintainReputation = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("reputationEvents")
      .paginate({ cursor: cursor ?? null, numItems: 25 })
    const communities = new Set<string>()
    for (const entry of page.page) {
      if (entry.reversedAt || entry.expiresAt <= Date.now()) continue
      if (["post", "discussion"].includes(entry.source) && entry.resourceId) {
        if (!communities.has(entry.resourceId)) {
          communities.add(entry.resourceId)
          await recomputeCommunity(ctx, entry.resourceId)
        }
      } else {
        const revision = entry.revisionId
          ? await ctx.db.get(entry.revisionId)
          : null
        const item = entry.resourceId
          ? await ctx.db.get(entry.resourceId)
          : null
        if (
          !item ||
          item.suppressed ||
          (entry.revisionId &&
            (!revision ||
              revision.suppressed ||
              revision.status !== "published"))
        )
          await reverseSource(
            ctx,
            entry.source,
            entry.sourceId,
            "The validated source is no longer eligible."
          )
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.governance.maintainReputation, {
        cursor: page.continueCursor,
      })
  },
})
export const communityCredit = internalMutation({
  args: { resourceId: v.id("resources") },
  handler: async (ctx, { resourceId }) => {
    await recomputeCommunity(ctx, resourceId)
  },
})
export const networkGate = internalMutation({
  args: {
    nonce: v.string(),
    ipHash: v.string(),
    appeal: v.boolean(),
    report: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    if (
      await ctx.db
        .query("gatewayNonces")
        .withIndex("by_nonce", (q) => q.eq("nonce", args.nonce))
        .unique()
    )
      return { error: "REPLAY" }
    await ctx.db.insert("gatewayNonces", {
      nonce: args.nonce,
      expiresAt: Date.now() + 120000,
    })
    if (!args.appeal && (await principalRestricted(ctx, `ip:${args.ipHash}`))) {
      await metric(ctx, "moderation:blocked_network_attempt")
      return { error: "BANNED" }
    }
    if (args.report) {
      const bucket = `report-ip:${args.ipHash}`
      const current = await ctx.db
        .query("limits")
        .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
        .unique()
      const count =
        current && current.resetAt > Date.now() ? current.count + 1 : 1
      const fields = {
        count,
        resetAt:
          current && current.resetAt > Date.now()
            ? current.resetAt
            : Date.now() + DAY,
      }
      if (current) await ctx.db.patch(current._id, fields)
      else await ctx.db.insert("limits", { bucket, ...fields })
      if (count > 10) {
        await metric(ctx, "moderation:report_rate_limited")
        return { error: "RATE_LIMITED" }
      }
    }
    // Keep failed attempts outside downstream command transactions.
    const bucket = `network:${args.ipHash}`,
      current = await ctx.db
        .query("limits")
        .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
        .unique()
    const count =
      current && current.resetAt > Date.now() ? current.count + 1 : 1
    if (current)
      await ctx.db.patch(current._id, {
        count,
        resetAt:
          current.resetAt > Date.now() ? current.resetAt : Date.now() + 60000,
      })
    else
      await ctx.db.insert("limits", {
        bucket,
        count,
        resetAt: Date.now() + 60000,
      })
    return count > (args.appeal ? 10 : 120)
      ? { error: "RATE_LIMITED" }
      : { error: null }
  },
})
export const recordNetwork = internalMutation({
  args: {
    ipHash: v.string(),
    agentId: v.optional(v.id("agents")),
    targetId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await observe(ctx, args.ipHash, args.agentId, args.targetId)
  },
})
export const retention = internalMutation({
  args: {},
  handler: async (ctx) => {
    await startRetention(ctx, "network")
    await startRetention(ctx, "evidence")
  },
})
export const retireEvidence = internalMutation({
  args: {
    cursor: v.optional(v.string()),
    generation: v.optional(v.number()),
    step: v.optional(v.number()),
  },
  handler: async (ctx, { generation, step }) => {
    if (generation === undefined || step === undefined) {
      await startRetention(ctx, "evidence")
      return
    }
    await retireEvidencePage(ctx, generation, step)
  },
})
