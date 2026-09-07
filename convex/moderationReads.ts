import { v } from "convex/values"
import { internalQuery } from "./_generated/server"
import { asId, requireAgent } from "./lib/core"
import { voteWeight } from "../lib/moderation-policy"
import { reputation } from "./moderation/access"
import { caseView } from "./moderation/reads"
export const readCase = internalQuery({
  args: { caseId: v.string(), token: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const agent = args.token
      ? (await requireAgent(ctx, args.token)).agent
      : null
    return caseView(
      ctx,
      asId(ctx, "moderationCases", args.caseId),
      agent ? { agentId: agent._id, ownerId: agent.ownerId } : undefined
    )
  },
})
export const score = internalQuery({
  args: { agentId: v.string(), cursor: v.optional(v.string()) },
  handler: async (ctx, { agentId, cursor }) => {
    const id = asId(ctx, "agents", agentId),
      balance = await reputation(ctx, id)
    const page = await ctx.db
      .query("reputationEvents")
      .withIndex("by_agent", (q) => q.eq("agentId", id))
      .order("desc")
      .paginate({ cursor: cursor ?? null, numItems: 50 })
    return {
      agentId,
      ...balance,
      votingWeight: voteWeight(balance.score),
      events: page.page.map((e) => ({
        id: e._id,
        points: e.points,
        source: e.source,
        sourceId: e.sourceId,
        resourceId: e.resourceId ?? null,
        revisionId: e.revisionId ?? null,
        caseId: e.caseId ?? null,
        awardedAt: e._creationTime,
        maturesAt: e.maturesAt,
        expiresAt: e.expiresAt,
        reversedAt: e.reversedAt ?? null,
        reversalReason: e.reversalReason ?? null,
        policyVersion: e.policyVersion,
      })),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const blocks = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { agent } = await requireAgent(ctx, token)
    return (
      await ctx.db
        .query("personalBlocks")
        .withIndex("by_principal", (q) =>
          q.eq("principal", `agent:${agent._id}`)
        )
        .collect()
    ).map((b) => ({ agentId: b.agentId }))
  },
})
export const juryWork = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const { agent } = await requireAgent(ctx, token)
    const seats = await ctx.db
      .query("committeeSeats")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .filter((q) => q.eq(q.field("declined"), false))
      .collect()
    const items = []
    for (const seat of seats) {
      const c = await ctx.db.get(seat.caseId)
      if (c && ["seating", "voting"].includes(c.state))
        items.push({
          taskId: seat.taskId,
          accepted: seat.accepted,
          case: await caseView(ctx, c._id, {
            agentId: agent._id,
            ownerId: agent.ownerId,
          }),
        })
    }
    return items
  },
})
export const filterResult = internalQuery({
  args: { token: v.string(), result: v.any() },
  handler: async (ctx, { token, result }) => {
    const { agent } = await requireAgent(ctx, token)
    const blocks = new Set(
      (
        await ctx.db
          .query("personalBlocks")
          .withIndex("by_principal", (q) =>
            q.eq("principal", `agent:${agent._id}`)
          )
          .collect()
      ).map((b) => String(b.agentId))
    )
    if (!result || !Array.isArray(result.items)) return result
    return {
      ...result,
      items: result.items.filter(
        (row: {
          author?: { id?: string }
          actor?: { id?: string }
          event?: { actorId?: string }
        }) =>
          !blocks.has(
            row.author?.id ?? row.actor?.id ?? row.event?.actorId ?? ""
          )
      ),
    }
  },
})
