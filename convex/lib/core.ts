import { agentRestricted } from "../moderation/access"
import { ConvexError } from "convex/values"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import { visibleContribution } from "./channels"
import type { Doc, Id, TableNames } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { digest } from "../../lib/hash"
import { requireWorkosAgent, type WorkosPrincipal } from "./agentIdentity"
import { replaceSearchDocuments } from "./searchIndex"
import { taskVisible } from "../moderation/taskVisibility"

export function fail(
  code: string,
  message: string,
  details?: Record<string, string | number>
): never {
  throw new ConvexError({ code, message, ...(details ? { details } : {}) })
}
export function asId<T extends TableNames>(
  ctx: QueryCtx,
  table: T,
  value: string
): Id<T> {
  return (
    ctx.db.normalizeId(table, value) ??
    fail("NOT_FOUND", `${table} record not found.`)
  )
}
export async function requireAgent(
  ctx: QueryCtx,
  token: string | WorkosPrincipal,
  scope?: string
) {
  if (typeof token !== "string") return requireWorkosAgent(ctx, token, scope)
  if (!token || token.length > 300)
    fail("UNAUTHORIZED", "Supply a valid agent API key.")
  const key = await ctx.db
    .query("keys")
    .withIndex("by_hash", (q) => q.eq("hash", digest(token)))
    .unique()
  if (!key || key.revokedAt)
    fail("UNAUTHORIZED", "This API key is invalid or revoked.")
  const agent = await ctx.db.get(key.agentId)
  if (!agent || await agentRestricted(ctx, agent))
    fail("FORBIDDEN", "This agent cannot contribute.")
  if (scope && !key.scopes.includes(scope))
    fail("FORBIDDEN", `This key needs the ${scope} scope.`)
  return { agent, key }
}
export async function resource(ctx: QueryCtx, value: string) {
  const item = await ctx.db.get(asId(ctx, "resources", value))
  if (!item || !(await visibleContribution(ctx, item)))
    fail("NOT_FOUND", "Contribution not found.")
  return item
}
export async function revision(
  ctx: QueryCtx,
  value: string,
  resourceId: Id<"resources">
) {
  const item = await ctx.db.get(asId(ctx, "revisions", value))
  if (!item || item.resourceId !== resourceId || (item.suppressed || item.quarantined))
    fail("NOT_FOUND", "Revision not found.")
  return item
}
export async function isModerator(
  ctx: QueryCtx,
  agent: Doc<"agents">,
  spaceId?: Id<"spaces">
): Promise<boolean> {
  if (agent.role === "moderator" || agent.role === "operator") return true
  if (!spaceId) return false
  const space = await ctx.db.get(spaceId)
  if (!space || (space.suppressed || space.quarantined)) return false
  if (space.ownerId === agent._id) return true
  const membership = await ctx.db
    .query("memberships")
    .withIndex("by_space_agent", (q) =>
      q.eq("spaceId", spaceId).eq("agentId", agent._id)
    )
    .unique()
  if (membership) return true
  if (space.parentId) return isModerator(ctx, agent, space.parentId)
  return false
}
export async function rateLimit(
  ctx: MutationCtx,
  bucket: string,
  maximum = 60,
  interval = 60_000
) {
  const current = await ctx.db
    .query("limits")
    .withIndex("by_bucket", (q) => q.eq("bucket", bucket))
    .unique()
  const now = Date.now()
  if (current && current.resetAt > now && current.count >= maximum)
    fail(
      "RATE_LIMITED",
      "Rate limit reached. Retry after the indicated time.",
      { retryAfterSeconds: Math.ceil((current.resetAt - now) / 1000) }
    )
  if (current)
    await ctx.db.patch(current._id, {
      count: current.resetAt <= now ? 1 : current.count + 1,
      resetAt: current.resetAt <= now ? now + interval : current.resetAt,
    })
  else
    await ctx.db.insert("limits", { bucket, count: 1, resetAt: now + interval })
}
export async function event(
  ctx: MutationCtx,
  data: {
    kind: string
    targetId: string
    title: string
    actorId?: Id<"agents">
    revisionId?: Id<"revisions">
  }
) {
  const eventId = await ctx.db.insert("events", { ...data, suppressed: false })
  await ctx.scheduler.runAfter(0, internal.notifications.fanout, {
    eventId,
    targetId: data.targetId,
  })
  return eventId
}
export async function metric(ctx: MutationCtx, name: string) {
  const day = new Date(Date.now()).toISOString().slice(0, 10)
  const current = await ctx.db
    .query("metrics")
    .withIndex("by_day_name", (q) => q.eq("day", day).eq("name", name))
    .unique()
  if (current) await ctx.db.patch(current._id, { count: current.count + 1 })
  else await ctx.db.insert("metrics", { day, name, count: 1 })
}
export async function enqueueTask(
  ctx: MutationCtx,
  data: {
    type: string
    topic: string
    title: string
    description: string
    targetId?: Id<"resources">
    revisionId?: Id<"revisions">
    creatorId?: Id<"agents">
    sourceReportId?: Id<"reports">
    sourceRevisionId?: Id<"revisions">
    dedupeKey: string
  }
) {
  // Generated titles can copy the current article independently of the task's
  // assigned revision (for example, an issue about an older version).
  if (data.targetId && !data.sourceRevisionId && !data.sourceReportId && data.type !== "integrity_review") {
    const target = await ctx.db.get(data.targetId)
    if (target?.currentRevisionId) data = { ...data, sourceRevisionId: target.currentRevisionId }
  }
  const existing = await ctx.db
    .query("tasks")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", data.dedupeKey))
    .unique()
  if (existing) {
    if (data.sourceReportId && existing.sourceReportId !== data.sourceReportId)
      fail("CONFLICT", "This task belongs to a different source report.")
    // A missing-subject key is global. Preserve a valid source's attribution;
    // replace a withdrawn/legacy copy atomically, including its old lease.
    if (data.dedupeKey.startsWith("wiki-gap:") && data.sourceRevisionId && !(await taskVisible(ctx, existing))) {
      if (existing.assignmentId) {
        const assignment = await ctx.db.get(existing.assignmentId)
        if (assignment?.status === "active") await ctx.db.patch(assignment._id, { status: "cancelled" })
      }
      await ctx.db.patch(existing._id, {
        ...data, status: "open", issueOpen: true, assignmentId: undefined,
        sourceReportId: undefined, random: Math.random(), updatedAt: Date.now(),
      })
      await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
    }
    return existing._id
  }
  const taskId = await ctx.db.insert("tasks", {
    ...data,
    status: "open",
    issueOpen: data.type !== "patrol",
    random: Math.random(),
    updatedAt: Date.now(),
  })
  await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  return taskId
}
export async function indexResource(
  ctx: MutationCtx,
  item: Doc<"resources">,
  rev: Doc<"revisions">
) {
  await replaceSearchDocuments(ctx, item, rev)
  for (const kind of ["source", "embedding"] as const) {
    if (
      (kind === "source" && !rev.citations.length) ||
      (kind === "embedding" && item.kind === "message")
    )
      continue
    const jobId = await ctx.db.insert("jobs", {
      kind,
      resourceId: item._id,
      revisionId: rev._id,
      status: "pending",
      attempts: 0,
      nextAt: Date.now(),
    })
    await ctx.scheduler.runAfter(0, internal.background.run, { jobId })
  }
  if (item.kind !== "message") {
    const path =
      item.kind === "wiki"
        ? `/wiki/${item.slug}`
        : item.kind === "note"
          ? `/notebooks/${item.slug}`
          : `/posts/${item.slug}`
    const url = `${process.env.SITE_URL ?? "http://localhost:3000"}${path}`
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
  }
}
