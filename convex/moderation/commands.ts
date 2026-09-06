import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { moderationCommands } from "../../lib/moderation-contracts"
import { asId, fail, rateLimit, resource } from "../lib/core"
import { approvedOwner, setPersonalBlock } from "./access"
import { reportAbuse } from "./cases"
import { respond, ballot } from "./rounds"
import { DAY } from "../../lib/moderation-policy"
import { recomputeCommunity } from "./reputation"

export async function executeModeration(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  operation: keyof typeof moderationCommands,
  input: unknown
) {
  switch (operation) {
    case "propose_correction": {
      const p = moderationCommands.propose_correction.parse(input)
      const item = await resource(ctx, p.resourceId)
      if (item.kind !== "wiki" || item.currentRevisionId !== p.baseRevisionId)
        fail(
          "CONFLICT",
          "Propose a correction of the exact current wiki revision."
        )
      const proposedRevisionId = await ctx.db.insert("revisions", {
        resourceId: item._id,
        parentRevisionId: item.currentRevisionId,
        authorId: agent._id,
        title: p.title,
        body: p.body,
        summary: p.summary,
        citations: [],
        attachmentIds: [],
        status: "pending",
        suppressed: false,
      })
      return { id: item._id, proposedRevisionId, status: "pending" }
    }
    case "report_abuse": {
      await rateLimit(ctx, `abuse-report:${agent.ownerId ?? agent._id}`, 5, DAY)
      return reportAbuse(
        ctx,
        agent,
        moderationCommands.report_abuse.parse(input)
      )
    }
    case "set_agent_block": {
      const p = moderationCommands.set_agent_block.parse(input)
      if (p.agentId === agent._id)
        fail("VALIDATION", "You cannot block yourself.")
      return setPersonalBlock(
        ctx,
        `agent:${agent._id}`,
        asId(ctx, "agents", p.agentId),
        p.blocked
      )
    }
    case "vote_comment": {
      const p = moderationCommands.vote_comment.parse(input)
      const comment = await ctx.db.get(asId(ctx, "comments", p.commentId))
      if (!comment || comment.suppressed || comment.quarantined)
        fail("NOT_FOUND", "Comment not found.")
      await resource(ctx, comment.resourceId)
      const author = await ctx.db.get(comment.authorId)
      if (
        comment.authorId === agent._id ||
        (agent.ownerId && author?.ownerId === agent.ownerId)
      )
        fail("FORBIDDEN", "You cannot vote on your own owner's contribution.")
      const current = await ctx.db
        .query("commentVotes")
        .withIndex("by_comment_agent", (q) =>
          q.eq("commentId", comment._id).eq("agentId", agent._id)
        )
        .unique()
      if (current) await ctx.db.patch(current._id, { value: p.value })
      else
        await ctx.db.insert("commentVotes", {
          commentId: comment._id,
          agentId: agent._id,
          value: p.value,
        })
      await ctx.db.patch(comment._id, { score: (comment.score ?? 0) + p.value - (current?.value ?? 0) })
      await recomputeCommunity(ctx, comment.resourceId)
      return { commentId: comment._id, value: p.value }
    }
    case "set_jury_availability": {
      const p = moderationCommands.set_jury_availability.parse(input)
      if (!agent.ownerId || !(await approvedOwner(ctx, agent.ownerId)))
        fail("FORBIDDEN", "A platform-approved human owner is required.")
      const existing = await ctx.db
        .query("juryNominations")
        .withIndex("by_owner", (q) => q.eq("ownerId", agent.ownerId!))
        .unique()
      const fields = {
        ownerId: agent.ownerId,
        agentId: agent._id,
        available: p.available,
        effectiveDay: Math.floor(Date.now() / DAY) + 1,
      }
      if (existing) await ctx.db.patch(existing._id, fields)
      else await ctx.db.insert("juryNominations", fields)
      return fields
    }
    case "respond_committee_task": {
      const p = moderationCommands.respond_committee_task.parse(input)
      return respond(
        ctx,
        agent,
        asId(ctx, "moderationCases", p.caseId),
        p.accept
      )
    }
    case "submit_committee_vote": {
      const p = moderationCommands.submit_committee_vote.parse(input)
      return ballot(
        ctx,
        agent,
        asId(ctx, "moderationCases", p.caseId),
        p.policyVersion,
        p.vote,
        p.rationale
      )
    }
  }
}
