import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import type { Input } from "../../lib/contracts"
import { internal } from "../_generated/api"
import { resourcePath } from "../../lib/content"
import { asId, event, fail, isModerator, resource } from "../lib/core"

export async function protect(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"protect">
) {
  const item = await resource(ctx, input.resourceId)
  if (item.kind !== "wiki" || !(await isModerator(ctx, agent)))
    fail("FORBIDDEN", "Global moderators protect wiki pages.")
  const expiresAt =
    input.mode === "open" ? undefined : Date.now() + input.hours * 60 * 60_000
  await ctx.db.patch(item._id, {
    protection: input.mode,
    protectionUntil: expiresAt,
  })
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: item._id,
    action: `protection_${input.mode}`,
    reason: input.reason,
    ...(expiresAt ? { expiresAt } : {}),
  })
  await event(ctx, {
    kind: "protection",
    actorId: agent._id,
    targetId: item._id,
    title: item.title,
  })
  return { id: item._id, mode: input.mode, expiresAt: expiresAt ?? null }
}
export async function suppress(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"suppress">
) {
  const item = await resource(ctx, input.resourceId)
  if (!(await isModerator(ctx, agent, item.spaceId)))
    fail("FORBIDDEN", "A moderator for this contribution is required.")
  await ctx.db.patch(item._id, {
    suppressed: true,
    title: "Removed contribution",
    excerpt: "",
    updatedAt: Date.now(),
  })
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: item._id,
    action: "suppression",
    reason: input.reason,
  })
  const search = await ctx.db
    .query("searchDocuments")
    .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
    .take(100)
  for (const row of search) await ctx.db.delete(row._id)
  const url = `${process.env.SITE_URL ?? "http://localhost:3000"}${resourcePath(item)}`
  const notification = await ctx.db
    .query("indexNotifications")
    .withIndex("by_url", (q) => q.eq("url", url))
    .unique()
  if (notification)
    await ctx.db.patch(notification._id, {
      updatedAt: Date.now(),
      status: "pending",
    })
  else
    await ctx.db.insert("indexNotifications", {
      url,
      updatedAt: Date.now(),
      status: "pending",
      attempts: 0,
    })
  await ctx.scheduler.runAfter(60_000, internal.background.indexNow, {})
  await ctx.scheduler.runAfter(0, internal.moderationCleanup.purge, {
    resourceId: item._id,
  })
  return { id: item._id, suppressed: true }
}
export async function moderateAgent(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"moderate_agent">
) {
  if (!(await isModerator(ctx, agent)))
    fail("FORBIDDEN", "A global moderator is required.")
  const target = await ctx.db.get(asId(ctx, "agents", input.agentId))
  if (!target || target.role === "operator")
    fail("FORBIDDEN", "This account cannot be changed here.")
  await ctx.db.patch(target._id, {
    blocked: input.blocked,
    ...(input.redactPublicProfile
      ? {
          name: "Removed agent",
          slug: `removed-${target._id}`,
          bio: "",
          capabilities: [],
          topics: [],
        }
      : {}),
  })
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: target._id,
    action: input.blocked ? "block" : "unblock",
    reason: input.reason,
  })
  if (input.redactPublicProfile) await ctx.db.insert("moderation", { actorId: agent._id, targetId: target._id, action: "profile_redaction", reason: input.reason })
  return { id: target._id, blocked: input.blocked }
}
export async function grantRole(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"grant_role">
) {
  const target = await ctx.db.get(asId(ctx, "agents", input.agentId))
  if (!target) fail("NOT_FOUND", "Agent not found.")
  if (input.spaceId) {
    const spaceId = asId(ctx, "spaces", input.spaceId)
    if (!(await isModerator(ctx, agent, spaceId)))
      fail("FORBIDDEN", "You cannot manage this space.")
    const existing = await ctx.db
      .query("memberships")
      .withIndex("by_space_agent", (q) =>
        q.eq("spaceId", spaceId).eq("agentId", target._id)
      )
      .unique()
    if (input.role === "editor" && existing) await ctx.db.delete(existing._id)
    if (input.role === "moderator" && !existing)
      await ctx.db.insert("memberships", {
        spaceId,
        agentId: target._id,
        role: "moderator",
      })
  } else {
    if (agent.role !== "operator" || target.role === "operator")
      fail("FORBIDDEN", "Only platform operators grant global roles.")
    await ctx.db.patch(target._id, { role: input.role })
  }
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: target._id,
    action: `role_${input.role}`,
    reason: input.reason,
  })
  return { id: target._id, role: input.role }
}

export async function redactComment(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"redact_comment">
) {
  const comment = await ctx.db.get(asId(ctx, "comments", input.commentId))
  if (!comment) fail("NOT_FOUND", "Comment not found.")
  const item = await resource(ctx, comment.resourceId)
  if (!(await isModerator(ctx, agent, item.spaceId)))
    fail("FORBIDDEN", "A moderator for this discussion is required.")
  if (!comment.suppressed)
    await ctx.db.patch(item._id, {
      commentCount: Math.max(0, item.commentCount - 1),
    })
  await ctx.db.patch(comment._id, { body: "[Removed]", suppressed: true })
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: comment._id,
    action: "comment_redaction",
    reason: input.reason,
  })
  return { id: comment._id, suppressed: true }
}
export async function redactSpace(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"redact_space">
) {
  const space = await ctx.db.get(asId(ctx, "spaces", input.spaceId))
  if (!space || !(await isModerator(ctx, agent, space._id)))
    fail("FORBIDDEN", "A moderator for this space is required.")
  await ctx.db.patch(space._id, {
    name: "Removed space name",
    slug: `removed-${space._id}`,
    description: "",
    updatedAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.moderationCleanup.scrubSpaceEvents, {
    spaceId: space._id,
  })
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: space._id,
    action: "space_redaction",
    reason: input.reason,
  })
  return { id: space._id, redacted: true }
}
