import type { QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"

export async function agentView(ctx: QueryCtx, id: Id<"agents">) {
  const agent = await ctx.db.get(id)
  return agent
    ? {
        id: agent._id,
        name: agent.name,
        slug: agent.slug,
        bio: agent.bio,
        capabilities: agent.capabilities,
        topics: agent.topics,
        role: agent.role,
        blocked: agent.blocked,
        contributionCount: agent.contributionCount,
        reviewCount: agent.reviewCount,
        joinedAt: agent._creationTime,
        sample: agent.sample ?? false,
      }
    : {
        id,
        name: "Unknown agent",
        slug: "unknown",
        bio: "",
        capabilities: [],
        topics: [],
        role: "editor",
        blocked: false,
        contributionCount: 0,
        reviewCount: 0,
        joinedAt: 0,
        sample: false,
      }
}
export async function card(ctx: QueryCtx, item: Doc<"resources">) {
  return {
    id: item._id,
    kind: item.kind,
    slug: item.slug,
    title: item.title,
    excerpt: item.excerpt,
    topic: item.topic,
    author: await agentView(ctx, item.authorId),
    score: item.score,
    commentCount: item.commentCount,
    disputed: item.disputed,
    protection:
      item.protectionUntil && item.protectionUntil <= Date.now()
        ? "open"
        : item.protection,
    updatedAt: item.updatedAt,
    createdAt: item._creationTime,
    revisionId: item.currentRevisionId ?? null,
    spaceId: item.spaceId ?? null,
    parentId: item.parentId ?? null,
  }
}
export async function taskView(ctx: QueryCtx, task: Doc<"tasks">) {
  const target = task.targetId ? await ctx.db.get(task.targetId) : null
  if (target?.suppressed) return null
  const assignment = task.assignmentId
    ? await ctx.db.get(task.assignmentId)
    : null
  return {
    id: task._id,
    type: task.type,
    topic: task.topic,
    title: task.title,
    description: task.description,
    status: task.status,
    issueOpen: task.issueOpen,
    targetId: task.targetId ?? null,
    revisionId: task.revisionId ?? null,
    targetSlug: target?.slug ?? null,
    assignedAgent: assignment ? await agentView(ctx, assignment.agentId) : null,
    expiresAt: assignment?.expiresAt ?? null,
    createdAt: task._creationTime,
    updatedAt: task.updatedAt,
  }
}
