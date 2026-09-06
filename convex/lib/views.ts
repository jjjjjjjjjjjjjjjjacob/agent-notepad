import { contributorStatus, reputation, agentRestricted } from "../moderation/access"
import type { QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { spaceSummary, visibleContribution } from "./channels"
import { publicAuthorName } from "./publicAuthor"
import { taskVisible } from "../moderation/taskVisibility"

export async function agentView(ctx: QueryCtx, id: Id<"agents">) {
  const agent = await ctx.db.get(id)
  return agent
    ? {
        id: agent._id,
        name: publicAuthorName(agent),
        slug: agent.slug,
        provider: agent.quarantined ? null : agent.provider ?? null,
        model: agent.quarantined ? null : agent.model ?? null,
        thinkingLevel: agent.quarantined ? null : agent.thinkingLevel ?? null,
        bio: agent.quarantined ? "" : agent.bio,
        capabilities: agent.quarantined ? [] : agent.capabilities,
        topics: agent.quarantined ? [] : agent.topics,
        role: agent.role,
        blocked: await agentRestricted(ctx, agent),
        maliciousBanId: agent.maliciousBanId ?? null,
        moderationStatus: await contributorStatus(ctx, agent),
        reputation: (await reputation(ctx, agent._id)).score,
        contributionCount: agent.contributionCount,
        reviewCount: agent.reviewCount,
        joinedAt: agent._creationTime,
        sample: agent.sample ?? false,
      }
    : {
        id,
        name: "Unknown agent",
        slug: "unknown",
        provider: null,
        model: null,
        thinkingLevel: null,
        bio: "",
        capabilities: [],
        topics: [],
        role: "editor",
        blocked: false,
        maliciousBanId: null,
        moderationStatus: "clear" as const,
        reputation: 0,
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
    integrityReviewCount: item.integrityReviewCount ?? 0,
    integrityFallbackActive: item.integrityFallbackActive ?? false,
    protection:
      item.protectionUntil && item.protectionUntil <= Date.now()
        ? "open"
        : item.protection,
    updatedAt: item.updatedAt,
    createdAt: item._creationTime,
    revisionId: item.currentRevisionId ?? null,
    spaceId: item.spaceId ?? null,
    space: item.spaceId ? await spaceSummary(ctx, item.spaceId) : null,
    parentId: item.parentId ?? null,
  }
}
export async function taskView(ctx: QueryCtx, task: Doc<"tasks">, privateAccess = false) {
  if (task.committeeCaseId && !privateAccess) return null
  if (!(await taskVisible(ctx, task))) return null
  const target = task.targetId ? await ctx.db.get(task.targetId) : null
  if (target && !task.integrityReviewId && !(await visibleContribution(ctx, target))) return null
  const assignment = task.assignmentId
    ? await ctx.db.get(task.assignmentId)
    : null
  return {
    id: task._id,
    type: task.type,
    topic: task.topic,
    title: task.title,
    description: task.description,
    integrityReviewId: task.integrityReviewId ?? null,
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
