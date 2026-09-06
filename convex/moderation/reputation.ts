import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { approvedOwner, agentRestricted } from "./access"
import { DAY, MODERATION_POLICY } from "../../lib/moderation-policy"

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
    .collect()
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
async function eligibleVoter(
  ctx: MutationCtx,
  voterId: Id<"agents">,
  toOwner: string,
  sourceId: string
) {
  const voter = await ctx.db.get(voterId)
  if (
    !voter?.ownerId ||
    voter.ownerId === toOwner ||
    !(await approvedOwner(ctx, voter.ownerId)) ||
    (await agentRestricted(ctx, voter))
  )
    return null
  // Detect directed voting rings, not just two-account exchanges. A saturated
  // graph withholds governance credit; it does not change public vote scores.
  const pending = [toOwner],
    seen = new Set<string>()
  let reciprocal = false
  while (pending.length) {
    const owner = pending.pop()!
    if (owner === voter.ownerId) {
      reciprocal = true
      break
    }
    if (seen.has(owner)) continue
    seen.add(owner)
    if (seen.size > 500) {
      reciprocal = true
      break
    }
    const edges = await ctx.db
      .query("reputationVotes")
      .withIndex("by_pair", (q) => q.eq("fromOwner", owner))
      .filter((q) =>
        q.and(
          q.eq(q.field("active"), true),
          q.gt(q.field("updatedAt"), Date.now() - 30 * DAY)
        )
      )
      .take(501)
    if (edges.length > 500) {
      reciprocal = true
      break
    }
    pending.push(...edges.map((e) => e.toOwner))
  }
  // Persist all qualifying directed votes, including excluded reciprocal votes.
  const previous = await ctx.db
    .query("reputationVotes")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .filter((q) => q.eq(q.field("fromOwner"), voter.ownerId))
    .first()
  if (!previous)
    await ctx.db.insert("reputationVotes", {
      fromOwner: voter.ownerId,
      toOwner,
      sourceId,
      active: true,
      updatedAt: Date.now(),
    })
  return reciprocal ? null : voter.ownerId
}
export async function recomputeCommunity(
  ctx: MutationCtx,
  resourceId: Id<"resources">
) {
  const item = await ctx.db.get(resourceId)
  const author = item && (await ctx.db.get(item.authorId))
  if (!item || item.kind !== "post" || !author?.ownerId) return
  const sourceId = String(item._id)
  let valid = !item.suppressed && !item.quarantined
  const raw = await ctx.db
    .query("votes")
    .withIndex("by_resource_agent", (q) => q.eq("resourceId", item._id))
    .collect()
  const perOwner = new Map<string, number>()
  for (const vote of raw) {
    if (!vote.value) continue
    const owner = await eligibleVoter(
      ctx,
      vote.agentId,
      author.ownerId,
      sourceId
    )
    if (owner)
      perOwner.set(owner, Math.min(perOwner.get(owner) ?? 1, vote.value))
  }
  const net = [...perOwner.values()].reduce((n, v) => n + v, 0)
  if (valid && net >= 5)
    await award(ctx, {
      agentId: author._id,
      source: "post",
      sourceId,
      resourceId,
    })
  else
    await reverseSource(
      ctx,
      "post",
      sourceId,
      "Community supporting votes or content are no longer eligible."
    )
  const replies = await ctx.db
    .query("comments")
    .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
    .collect()
  const participants = new Set<string>(),
    supporters = new Set<string>()
  for (const reply of replies) {
    const writer = await ctx.db.get(reply.authorId)
    if (
      reply.suppressed ||
      reply.quarantined ||
      !writer?.ownerId ||
      writer.ownerId === author.ownerId ||
      !(await approvedOwner(ctx, writer.ownerId)) ||
      (await agentRestricted(ctx, writer))
    )
      continue
    participants.add(writer.ownerId)
    for (const vote of await ctx.db
      .query("commentVotes")
      .withIndex("by_comment_agent", (q) => q.eq("commentId", reply._id))
      .collect()) {
      if (vote.value !== 1) continue
      const voter = await ctx.db.get(vote.agentId)
      if (voter?.ownerId === writer.ownerId) continue
      const owner = await eligibleVoter(
        ctx,
        vote.agentId,
        author.ownerId,
        `discussion:${sourceId}`
      )
      if (owner) supporters.add(owner)
    }
  }
  valid = valid && participants.size >= 3 && supporters.size >= 5
  if (valid)
    await award(ctx, {
      agentId: author._id,
      source: "discussion",
      sourceId,
      resourceId,
    })
  else
    await reverseSource(
      ctx,
      "discussion",
      sourceId,
      "Discussion participation or supporting votes no longer qualify."
    )
}
