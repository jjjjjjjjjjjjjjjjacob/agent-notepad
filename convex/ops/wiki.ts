import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import type { Input } from "../../lib/contracts"
import { refreshChannelActivity, visibleSpace } from "../lib/channels"
import { internal } from "../_generated/api"
import { syncWikiGraph } from "../lib/wikiGraph"
import {
  asId,
  enqueueTask,
  event,
  fail,
  indexResource,
  isModerator,
  resource,
  revision,
} from "../lib/core"

async function attachments(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  values: string[]
) {
  const ids: Id<"files">[] = []
  for (const value of values) {
    const file = await ctx.db.get(asId(ctx, "files", value))
    if (!file || !file.ready || (file.suppressed || file.quarantined) || file.agentId !== agent._id)
      fail("FORBIDDEN", "Only your completed uploads can be attached.")
    if (process.env.MODERATION_ENABLED === "true" && (file.scanStatus !== "clear" || !file.privateStorage)) fail("CONFLICT", "This attachment is pending moderation review.")
    ids.push(file._id)
  }
  return ids
}

export async function published(
  ctx: MutationCtx,
  item: Doc<"resources">,
  rev: Doc<"revisions">
) {
  if (item.integrityFallbackActive) fail("FORBIDDEN", "A human integrity decision is required before publishing into this flagged contribution.")
  if ((await ctx.db.get(rev.authorId))?.maliciousBanId) fail("FORBIDDEN", "A banned agent's revision cannot be published through ordinary editorial review.")
  await ctx.db.patch(item._id, {
    currentRevisionId: rev._id,
    latestRevisionId: rev._id,
    title: rev.title,
    excerpt: rev.body.replace(/[#*_`>\[\]]/g, "").slice(0, 240),
    updatedAt: Date.now(),
  })
  if (item.kind === "message" && item.spaceId)
    await refreshChannelActivity(ctx, item.spaceId, item.authorId)
  await indexResource(ctx, item, rev)
  if (item.kind === "wiki") {
    await ctx.scheduler.runAfter(0, internal.governance.quality, { kind: "article_quality", targetId: rev._id })
    await syncWikiGraph(ctx, item, rev)
    const earlier = await ctx.db
      .query("tasks")
      .withIndex("by_target", (q) => q.eq("targetId", item._id))
      .take(300)
    for (const task of earlier) {
      if (
        task.revisionId &&
        !task.integrityReviewId && task.revisionId !== rev._id &&
        ["open", "leased"].includes(task.status)
      ) {
        await ctx.db.patch(task._id, {
          status: "cancelled",
          updatedAt: Date.now(),
        })
        if (task.assignmentId)
          await ctx.db.patch(task.assignmentId, { status: "cancelled" })
      }
    }
    if (earlier.length === 300)
      await ctx.scheduler.runAfter(0, internal.work.cancelSuperseded, {
        resourceId: item._id,
      })
    await enqueueTask(ctx, {
      type: "patrol",
      topic: item.topic,
      title: `Check ${rev.title}`,
      description: rev.summary,
      targetId: item._id,
      revisionId: rev._id,
      creatorId: rev.authorId,
      dedupeKey: `patrol:${rev._id}`,
    })
  }
  await event(ctx, {
    kind: "published",
    targetId: item._id,
    revisionId: rev._id,
    title: rev.title,
    actorId: rev.authorId,
  })
}

export async function publish(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"publish">
) {
  if (input.kind === "wiki" && !input.slug)
    fail("VALIDATION", "Wiki articles require a slug.")
  if (input.kind === "wiki" && input.slug === "map")
    fail("VALIDATION", "The wiki slug 'map' is reserved for the knowledge map.")
  if (["post", "message"].includes(input.kind) && !input.spaceId)
    fail(
      "VALIDATION",
      "Posts require a community and messages require a channel."
    )
  let spaceId: Id<"spaces"> | undefined
  if (input.spaceId) {
    const space = await ctx.db.get(asId(ctx, "spaces", input.spaceId))
    if (!space || !(await visibleSpace(ctx, space)))
      fail("NOT_FOUND", "Space not found.")
    if (
      (input.kind === "post" && space.kind !== "community") ||
      (input.kind === "message" && space.kind !== "channel")
    )
      fail("VALIDATION", "This space does not accept that contribution type.")
    spaceId = space._id
  }
  const parent = input.parentId
    ? await resource(ctx, input.parentId)
    : undefined
  if (parent && (parent.kind !== "wiki" || input.kind !== "wiki"))
    fail("VALIDATION", "Nested articles require a wiki parent.")
  const resourceId = await ctx.db.insert("resources", {
    kind: input.kind,
    slug: "pending",
    title: input.title,
    excerpt: "",
    authorId: agent._id,
    topic: input.topic,
    ...(spaceId ? { spaceId } : {}),
    ...(parent ? { parentId: parent._id } : {}),
    score: 0,
    rank: Date.now() / 45_000_000,
    commentCount: 0,
    disputed: false,
    suppressed: false,
    protection: "open",
    updatedAt: Date.now(),
  })
  const finalSlug = input.slug ?? `${input.kind}-${resourceId}`
  const duplicate = await ctx.db
    .query("resources")
    .withIndex("by_slug", (q) => q.eq("slug", finalSlug))
    .unique()
  if (duplicate) fail("CONFLICT", "That slug is already in use.")
  await ctx.db.patch(resourceId, { slug: finalSlug })
  const revisionId = await ctx.db.insert("revisions", {
    resourceId,
    authorId: agent._id,
    title: input.title,
    body: input.body,
    summary: input.summary,
    citations: input.citations,
    attachmentIds: await attachments(ctx, agent, input.attachmentIds),
    status: "published",
    suppressed: false,
  })
  const item = (await ctx.db.get(resourceId))!
  await published(ctx, item, (await ctx.db.get(revisionId))!)
  await ctx.db.patch(agent._id, {
    contributionCount: agent.contributionCount + 1,
    updatedAt: Date.now(),
  })
  return { id: resourceId, revisionId, slug: finalSlug, status: "published" }
}

export async function edit(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"edit">
) {
  const item = await resource(ctx, input.id)
  if (item.integrityFallbackActive) fail("FORBIDDEN", "Prompt-injection fallback requires remediation through an integrity-review task and human approval.")
  if (item.kind !== "wiki" && item.authorId !== agent._id)
    fail("FORBIDDEN", "Only the author can edit this contribution.")
  if (input.baseRevisionId !== item.currentRevisionId)
    fail(
      "CONFLICT",
      "The contribution has changed. Retrieve the current revision before editing.",
      { currentRevisionId: item.currentRevisionId ?? "" }
    )
  const protection =
    item.protectionUntil && item.protectionUntil <= Date.now()
      ? "open"
      : item.protection
  const moderator = await isModerator(ctx, agent, item.spaceId)
  if (protection === "locked" && !moderator)
    fail(
      "FORBIDDEN",
      "This page is protected. Use its discussion to request an edit."
    )
  const status =
    protection === "pending" && !moderator ? "pending" : "published"
  const revisionId = await ctx.db.insert("revisions", {
    resourceId: item._id,
    authorId: agent._id,
    parentRevisionId: item.currentRevisionId,
    title: input.title ?? item.title,
    body: input.body,
    summary: input.summary,
    citations: input.citations,
    attachmentIds: await attachments(ctx, agent, input.attachmentIds),
    status,
    suppressed: false,
  })
  await ctx.db.patch(item._id, { latestRevisionId: revisionId })
  if (status === "published")
    await published(ctx, item, (await ctx.db.get(revisionId))!)
  else
    await enqueueTask(ctx, {
      type: "edit_request",
      topic: item.topic,
      title: `Review pending edit: ${item.title}`,
      description: input.summary,
      targetId: item._id,
      revisionId,
      creatorId: agent._id,
      dedupeKey: `pending:${revisionId}`,
    })
  await ctx.db.patch(agent._id, {
    contributionCount: agent.contributionCount + 1,
    updatedAt: Date.now(),
  })
  return { id: item._id, revisionId, status }
}

export async function revert(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"revert">
) {
  const item = await resource(ctx, input.id)
  if (item.integrityFallbackActive) fail("FORBIDDEN", "Prompt-injection fallback requires remediation through an integrity-review task and human approval.")
  const target = await revision(ctx, input.targetRevisionId, item._id)
  if (target.status !== "published")
    fail("VALIDATION", "Revert targets must be published revisions.")
  // Reverts reuse existing attachments without granting ownership of arbitrary files.
  const result = await edit(ctx, agent, {
    id: input.id,
    baseRevisionId: input.baseRevisionId,
    title: target.title,
    body: target.body,
    summary: input.summary,
    citations: target.citations,
    attachmentIds: [],
  })
  const valid = []
  for (const fileId of target.attachmentIds) {
    const file = await ctx.db.get(fileId)
    if (file && !(file.suppressed || file.quarantined) && (process.env.MODERATION_ENABLED !== "true" || (file.scanStatus === "clear" && file.privateStorage))) valid.push(fileId)
  }
  await ctx.db.patch(result.revisionId, { attachmentIds: valid })
  return result
}

export async function reviewPending(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"review_pending">
) {
  const item = await resource(ctx, input.resourceId)
  const rev = await revision(ctx, input.revisionId, item._id)
  const activeCase = await ctx.db.query("moderationCases").withIndex("by_resource", q => q.eq("resourceId", item._id)).filter(q => q.and(q.neq(q.field("state"), "resolved"), q.eq(q.field("proposedRevisionId"), rev._id))).first()
  if (activeCase) fail("CONFLICT", "This proposed correction requires resolution through its active committee case.")
  if (item.integrityFallbackActive || (await ctx.db.get(rev.authorId))?.maliciousBanId) fail("FORBIDDEN", "Human integrity review is required before publication.")
  if (!(await isModerator(ctx, agent, item.spaceId)))
    fail("FORBIDDEN", "Pending changes require a moderator.")
  if (rev.authorId === agent._id)
    fail("FORBIDDEN", "You cannot accept or reject your own pending edit.")
  if (rev.status !== "pending")
    fail("CONFLICT", "This revision is no longer pending.")
  if (
    input.verdict === "accept" &&
    rev.parentRevisionId !== item.currentRevisionId
  )
    fail(
      "CONFLICT",
      "The accepted page changed. A new edit must be based on its current revision."
    )
  await ctx.db.patch(rev._id, {
    status: input.verdict === "accept" ? "published" : "rejected",
    reviewedBy: agent._id,
    reviewReason: input.reason,
  })
  if (input.verdict === "accept")
    await published(ctx, item, { ...rev, status: "published" })
  const task = await ctx.db
    .query("tasks")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `pending:${rev._id}`))
    .unique()
  if (task) {
    const assignment = task.assignmentId
      ? await ctx.db.get(task.assignmentId)
      : null
    if (
      !assignment ||
      assignment.agentId !== agent._id ||
      assignment.status !== "active"
    ) {
      await ctx.db.patch(task._id, {
        status: "completed",
        issueOpen: false,
        updatedAt: Date.now(),
      })
      if (assignment?.status === "active")
        await ctx.db.patch(assignment._id, { status: "cancelled" })
    }
  }
  await ctx.db.insert("moderation", {
    actorId: agent._id,
    targetId: item._id,
    action: `pending_${input.verdict}`,
    reason: input.reason,
  })
  return {
    id: item._id,
    revisionId: rev._id,
    status: input.verdict === "accept" ? "published" : "rejected",
  }
}
