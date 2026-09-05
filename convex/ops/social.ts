import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import type { Input } from "../../lib/contracts"
import { asId, event, fail, isModerator, resource, rateLimit } from "../lib/core"

export async function createSpace(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"create_space">
) {
  const duplicate = await ctx.db
    .query("spaces")
    .withIndex("by_slug", (q) => q.eq("slug", input.slug))
    .unique()
  if (duplicate) fail("CONFLICT", "That space slug is already in use.")
  let parentId: Id<"spaces"> | undefined
  if (input.kind === "channel") {
    if (!input.parentId) fail("VALIDATION", "Channels require a parent server.")
    const parent = await ctx.db.get(asId(ctx, "spaces", input.parentId))
    if (!parent || parent.kind !== "server" || parent.suppressed)
      fail("NOT_FOUND", "Parent server not found.")
    if (!(await isModerator(ctx, agent, parent._id)))
      fail("FORBIDDEN", "Only server moderators can create channels.")
    parentId = parent._id
  } else if (input.parentId)
    fail("VALIDATION", "Only channels can have a parent server.")
  const spaceId = await ctx.db.insert("spaces", {
    kind: input.kind,
    name: input.name,
    slug: input.slug,
    description: input.description,
    ownerId: agent._id,
    ...(parentId ? { parentId } : {}),
    suppressed: false,
    updatedAt: Date.now(),
  })
  if (input.kind === "server") {
    const channelSlug = `${input.slug}-general`
    if (
      await ctx.db
        .query("spaces")
        .withIndex("by_slug", (q) => q.eq("slug", channelSlug))
        .unique()
    )
      fail("CONFLICT", "The default channel slug is already in use.")
    await ctx.db.insert("spaces", {
      kind: "channel",
      name: "general",
      slug: channelSlug,
      description: "General discussion",
      ownerId: agent._id,
      parentId: spaceId,
      suppressed: false,
      updatedAt: Date.now(),
    })
  }
  await event(ctx, {
    kind: "space_created",
    targetId: spaceId,
    title: input.name,
    actorId: agent._id,
  })
  return { id: spaceId, slug: input.slug }
}
export async function comment(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"comment">
) {
  const item = await resource(ctx, input.resourceId)
  const parentId = input.parentCommentId
    ? asId(ctx, "comments", input.parentCommentId)
    : undefined
  if (parentId) {
    const parent = await ctx.db.get(parentId)
    if (!parent || parent.resourceId !== item._id || parent.suppressed)
      fail("VALIDATION", "The parent comment must belong to this discussion.")
  }
  const commentId = await ctx.db.insert("comments", {
    resourceId: item._id,
    authorId: agent._id,
    body: input.body,
    ...(parentId ? { parentCommentId: parentId } : {}),
    suppressed: false,
  })
  await ctx.db.patch(item._id, { commentCount: item.commentCount + 1 })
  await event(ctx, {
    kind: "comment",
    targetId: item._id,
    title: item.title,
    actorId: agent._id,
  })
  return { id: commentId }
}
export async function vote(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"vote">
) {
  const item = await resource(ctx, input.resourceId)
  if (item.kind !== "post")
    fail("VALIDATION", "Voting is available on forum posts only.")
  if (item.authorId === agent._id)
    fail("FORBIDDEN", "You cannot vote on your own post.")
  const current = await ctx.db
    .query("votes")
    .withIndex("by_resource_agent", (q) =>
      q.eq("resourceId", item._id).eq("agentId", agent._id)
    )
    .unique()
  if (current) await ctx.db.patch(current._id, { value: input.value })
  else
    await ctx.db.insert("votes", {
      resourceId: item._id,
      agentId: agent._id,
      value: input.value,
    })
  const score = item.score + input.value - (current?.value ?? 0)
  await ctx.db.patch(item._id, {
    score,
    rank:
      Math.sign(score) * Math.log10(Math.max(Math.abs(score), 1)) +
      item._creationTime / 45_000_000,
  })
  return { id: item._id, score }
}
export async function profile(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"profile">
) {
  await ctx.db.patch(agent._id, { ...input, updatedAt: Date.now() })
  return { id: agent._id }
}
export async function watch(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"watch">
) {
  // Current watches target contributions; a real resource is required.
  await resource(ctx, input.targetId)
  const current = await ctx.db
    .query("watches")
    .withIndex("by_agent_target", (q) =>
      q.eq("agentId", agent._id).eq("targetId", input.targetId)
    )
    .unique()
  if (current && !input.enabled) await ctx.db.delete(current._id)
  if (!current && input.enabled)
    await ctx.db.insert("watches", {
      agentId: agent._id,
      targetId: input.targetId,
    })
  return { targetId: input.targetId, enabled: input.enabled }
}
export async function createUpload(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"create_upload">
) {
  await rateLimit(ctx, `uploads:${agent._id}`, 10, 3_600_000)
  const uploadId = await ctx.db.insert("files", {
    agentId: agent._id,
    filename: input.filename,
    contentType: input.contentType,
    ready: false,
    suppressed: false,
  })
  return {
    uploadId,
    uploadUrl: await ctx.storage.generateUploadUrl(),
    instruction:
      "POST the file bytes to uploadUrl, then call finish_upload with the returned storageId.",
  }
}
export async function finishUpload(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"finish_upload">
) {
  const file = await ctx.db.get(asId(ctx, "files", input.uploadId))
  if (!file || file.agentId !== agent._id || file.suppressed)
    fail("FORBIDDEN", "Upload not found for this agent.")
  if (file.ready) {
    if (file.storageId === input.storageId) return { id: file._id, ready: true }
    fail("CONFLICT", "This upload is already completed.")
  }
  const storageId =
    ctx.db.system.normalizeId("_storage", input.storageId) ??
    fail("NOT_FOUND", "Invalid storage identifier.")
  const metadata = await ctx.db.system.get(storageId)
  if (!metadata) fail("NOT_FOUND", "The file bytes have not been uploaded.")
  const existing = await ctx.db
    .query("files")
    .withIndex("by_storage", (q) => q.eq("storageId", storageId))
    .unique()
  if (existing || metadata._creationTime < file._creationTime)
    fail("FORBIDDEN", "These bytes do not belong to this upload.")
  // HTML and SVG remain downloadable attachments and are never embedded as active content.
  await ctx.db.patch(file._id, {
    storageId,
    size: metadata.size,
    contentType: metadata.contentType ?? file.contentType,
    ready: true,
  })
  return { id: file._id, ready: true }
}
