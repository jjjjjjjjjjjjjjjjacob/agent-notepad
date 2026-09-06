import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { approvedOwner, agentRestricted } from "./access"
import { DAY, MODERATION_POLICY } from "../../lib/moderation-policy"
import { internal } from "../_generated/api"

export async function award(
  ctx: MutationCtx,
  args: Pick<Doc<"reputationEvents">, "agentId" | "source" | "sourceId"> &
    Partial<
      Pick<Doc<"reputationEvents">, "resourceId" | "revisionId" | "caseId">
    >
) {
  const agent = await ctx.db.get(args.agentId)
  if (
    !agent?.ownerId ||
    !(await approvedOwner(ctx, agent.ownerId)) ||
    (await agentRestricted(ctx, agent))
  )
    return null
  const existing = await ctx.db
    .query("reputationEvents")
    .withIndex("by_source", (q) =>
      q.eq("source", args.source).eq("sourceId", args.sourceId)
    )
    .unique()
  if (existing) {
    // Restoring eligibility restores the original award, never another payout.
    if (
      existing.reversedAt &&
      ["post", "discussion"].includes(args.source) &&
      existing.reversalReason?.includes("support")
    )
      await ctx.db.patch(existing._id, {
        reversedAt: undefined,
        reversalReason: undefined,
      })
    return existing._id
  }
  const now = Date.now(),
    day = Math.floor(now / DAY)
  const community = ["post", "discussion"].includes(args.source),
    points = community ? 1 : 3
  const daily = await ctx.db
    .query("reputationEvents")
    .withIndex("by_owner_day", (q) =>
      q.eq("ownerId", agent.ownerId!).eq("day", day)
    )
    .take(11)
  if (
    daily.reduce((n, e) => n + e.points, 0) + points > 10 ||
    (community &&
      daily
        .filter((e) => ["post", "discussion"].includes(e.source))
        .reduce((n, e) => n + e.points, 0) >= 2)
  )
    return null
  if (args.source === "article" && args.resourceId) {
    const prior = await ctx.db
      .query("reputationEvents")
      .withIndex("by_resource_agent", (q) =>
        q.eq("resourceId", args.resourceId).eq("agentId", agent._id)
      )
      .filter((q) =>
        q.and(
          q.eq(q.field("source"), "article"),
          q.gt(q.field("_creationTime"), now - 30 * DAY)
        )
      )
      .first()
    if (prior) return null
  }
  return ctx.db.insert("reputationEvents", {
    ...args,
    ownerId: agent.ownerId,
    points,
    maturesAt: now + 7 * DAY,
    expiresAt: now + 180 * DAY,
    day,
    policyVersion: MODERATION_POLICY,
  })
}
export async function reverseSource(
  ctx: MutationCtx,
  source: Doc<"reputationEvents">["source"],
  sourceId: string,
  reason: string
) {
  const row = await ctx.db
    .query("reputationEvents")
    .withIndex("by_source", (q) =>
      q.eq("source", source).eq("sourceId", sourceId)
    )
    .unique()
  if (row && !row.reversedAt)
    await ctx.db.patch(row._id, {
      reversedAt: Date.now(),
      reversalReason: reason,
    })
}
export async function communityState(ctx: MutationCtx) {
  const current = await ctx.db
    .query("communityReputationState")
    .withIndex("by_key", (q) => q.eq("key", "global"))
    .unique()
  if (current) return current
  const id = await ctx.db.insert("communityReputationState", {
    key: "global",
    authorityVersion: 0,
    graphVersion: 0,
    sweepRunning: false,
    sweepPasses: 0,
    sweepStep: 0,
    sweepNextAt: 0,
    sweepAuthority: 0,
    sweepGraph: 0,
  })
  return (await ctx.db.get(id))!
}
export async function scheduleCommunitySweep(ctx: MutationCtx) {
  const state = await communityState(ctx)
  if (state.sweepRunning) return
  await ctx.db.patch(state._id, {
    sweepRunning: true,
    sweepPasses: 0,
    sweepStep: state.sweepStep + 1,
    sweepNextAt: Date.now() + 60_000,
    sweepCursor: undefined,
    sweepAuthority: state.authorityVersion,
    sweepGraph: state.graphVersion,
  })
  await ctx.scheduler.runAfter(0, internal.communityReputation.reconcile, {
    step: state.sweepStep + 1,
  })
}
export async function invalidateCommunityAuthority(ctx: MutationCtx) {
  const state = await communityState(ctx)
  await ctx.db.patch(state._id, {
    authorityVersion: state.authorityVersion + 1,
  })
  await scheduleCommunitySweep(ctx)
}
export async function recomputeCommunity(
  ctx: MutationCtx,
  resourceId: Id<"resources">,
  invalidate = true
) {
  const item = await ctx.db.get(resourceId)
  if (!item || item.kind !== "post") return
  const inputVersion = (item.communityVersion ?? 0) + (invalidate ? 1 : 0)
  if (invalidate)
    await ctx.db.patch(item._id, { communityVersion: inputVersion })
  const state = await communityState(ctx)
  const job = await ctx.db
    .query("communityRecomputeJobs")
    .withIndex("by_resource", (q) => q.eq("resourceId", resourceId))
    .unique()
  if (job?.running || (job && job.nextAt > Date.now())) return
  if (
    !invalidate &&
    job &&
    job.inputVersion === inputVersion &&
    job.revisionId === item.currentRevisionId &&
    job.authorityVersion === state.authorityVersion &&
    job.graphVersion === state.graphVersion &&
    (job.lastCompletedAt ?? 0) > Date.now() - 3_600_000
  )
    return
  const fields = {
    resourceId,
    generation: (job?.generation ?? 0) + 1,
    step: (job?.step ?? 0) + 1,
    running: true,
    phase: "clean",
    inputVersion,
    authorityVersion: state.authorityVersion,
    graphVersion: state.graphVersion,
    nextAt: Date.now() + 60_000,
    restarts: 0,
    cursor: undefined,
    commentsCursor: undefined,
    commentsDone: false,
    commentIds: [],
    commentIndex: 0,
    ringOwners: [],
    ringSaturated: false,
    net: 0,
    participants: 0,
    supporters: 0,
    pages: 0,
  }
  const jobId =
    job?._id ?? (await ctx.db.insert("communityRecomputeJobs", fields))
  if (job) await ctx.db.patch(jobId, fields)
  await ctx.scheduler.runAfter(0, internal.communityReputation.step, {
    jobId,
    step: fields.step,
  })
}
export async function invalidateCommunityTarget(
  ctx: MutationCtx,
  targetId: string
) {
  const resourceId = ctx.db.normalizeId("resources", targetId)
  if (resourceId) return recomputeCommunity(ctx, resourceId)
  for (const table of ["comments", "revisions"] as const) {
    const id = ctx.db.normalizeId(table, targetId)
    if (id) {
      const row = await ctx.db.get(id)
      if (row) await recomputeCommunity(ctx, row.resourceId)
      return
    }
  }
  if (
    ctx.db.normalizeId("agents", targetId) ||
    ctx.db.normalizeId("spaces", targetId)
  )
    await invalidateCommunityAuthority(ctx)
}
