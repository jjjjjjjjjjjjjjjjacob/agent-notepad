import { internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { enqueueTask, metric, rateLimit } from "./lib/core"
import { MAX_SEARCH_CHUNKS } from "../lib/retrieval"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../lib/embedding-config"

export const start = internalMutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (
      !job ||
      !["pending", "retry"].includes(job.status) ||
      job.nextAt > Date.now()
    )
      return null
    const resource = await ctx.db.get(job.resourceId)
    const revision = await ctx.db.get(job.revisionId)
    if (
      !resource ||
      resource.suppressed ||
      resource.quarantined ||
      resource.currentRevisionId !== job.revisionId ||
      !revision ||
      revision.suppressed ||
      revision.quarantined
    ) {
      await ctx.db.patch(job._id, { status: "cancelled" })
      return null
    }
    const budgetName = `external:${job.kind}`
    const chunks = (
      await ctx.db
        .query("searchDocuments")
        .withIndex("by_resource", (q) => q.eq("resourceId", resource._id))
        .take(MAX_SEARCH_CHUNKS + 1)
    ).filter(
      (chunk) =>
        chunk.revisionId === job.revisionId &&
        (!chunk.embeddingBge || chunk.embeddingModel !== EMBEDDING_MODEL)
    )
    const budget = await ctx.db
      .query("limits")
      .withIndex("by_bucket", (q) => q.eq("bucket", budgetName))
      .unique()
    const cost =
      job.kind === "source" ? revision.citations.length : chunks.length
    const maximum = job.kind === "source" ? 1200 : 4000
    if (
      budget &&
      budget.resetAt > Date.now() &&
      budget.count + cost > maximum
    ) {
      await ctx.db.patch(job._id, {
        status: "retry",
        nextAt: budget.resetAt,
        error: "Waiting for the platform's external-action budget.",
      })
      await ctx.scheduler.runAfter(
        budget.resetAt - Date.now(),
        internal.background.run,
        { jobId: job._id }
      )
      return null
    }
    if (budget)
      await ctx.db.patch(budget._id, {
        count: budget.resetAt > Date.now() ? budget.count + cost : cost,
        resetAt:
          budget.resetAt > Date.now() ? budget.resetAt : Date.now() + 3_600_000,
      })
    else
      await ctx.db.insert("limits", {
        bucket: budgetName,
        count: cost,
        resetAt: Date.now() + 3_600_000,
      })
    await ctx.db.patch(job._id, {
      status: "running",
      attempts: job.attempts + 1,
      nextAt: Date.now() + 10 * 60_000,
    })
    return { ...job, attempt: job.attempts + 1, revision, chunks }
  },
})
export const finish = internalMutation({
  args: {
    jobId: v.id("jobs"),
    attempt: v.number(),
    error: v.optional(v.string()),
    blocked: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId)
    if (!job || job.status !== "running" || job.attempts !== args.attempt)
      return
    if (!args.error) {
      await ctx.db.patch(job._id, { status: "completed", error: undefined })
      return
    }
    const status = args.blocked
      ? "blocked"
      : job.attempts < 4
        ? "retry"
        : "failed"
    const delay = Math.min(60_000 * 2 ** job.attempts, 30 * 60_000)
    await ctx.db.patch(job._id, {
      status,
      error: args.error.slice(0, 500),
      nextAt: Date.now() + delay,
    })
    if (status === "retry")
      await ctx.scheduler.runAfter(delay, internal.background.run, {
        jobId: job._id,
      })
  },
})
export const saveSource = internalMutation({
  args: {
    resourceId: v.id("resources"),
    revisionId: v.id("revisions"),
    url: v.string(),
    title: v.string(),
    status: v.string(),
    fingerprint: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const resource = await ctx.db.get(args.resourceId)
    if (!resource || resource.suppressed || resource.quarantined) return
    const existing = (
      await ctx.db
        .query("sources")
        .withIndex("by_revision", (q) => q.eq("revisionId", args.revisionId))
        .take(30)
    ).find((s) => s.url === args.url)
    if (existing)
      await ctx.db.patch(existing._id, { ...args, retrievedAt: Date.now() })
    else await ctx.db.insert("sources", { ...args, retrievedAt: Date.now() })
    await metric(
      ctx,
      args.status === "retrieved" ? "source.retrieved" : "source.unavailable"
    )
    if (
      args.status !== "retrieved" &&
      resource.currentRevisionId === args.revisionId
    )
      await enqueueTask(ctx, {
        type: "citation",
        topic: resource.topic,
        title: `Check a source: ${resource.title}`,
        description: `Automatic retrieval could not check ${args.url}. ${args.error ?? ""}`,
        targetId: resource._id,
        revisionId: args.revisionId,
        dedupeKey: `citation:${args.revisionId}:${args.url}`,
      })
  },
})
export const saveEmbedding = internalMutation({
  args: {
    id: v.id("searchDocuments"),
    revisionId: v.id("revisions"),
    embedding: v.array(v.float64()),
    model: v.string(),
  },
  handler: async (ctx, args) => {
    const chunk = await ctx.db.get(args.id)
    const resource = chunk ? await ctx.db.get(chunk.resourceId) : null
    if (
      chunk &&
      resource &&
      !(resource.suppressed || resource.quarantined) &&
      chunk.revisionId === args.revisionId &&
      (await ctx.db.get(args.revisionId))?.suppressed === false &&
      resource.currentRevisionId === args.revisionId &&
      args.model === EMBEDDING_MODEL &&
      args.embedding.length === EMBEDDING_DIMENSIONS &&
      args.embedding.every(Number.isFinite) &&
      Math.abs(Math.hypot(...args.embedding) - 1) < 0.01
    )
      await ctx.db.patch(chunk._id, {
        embeddingBge: args.embedding,
        embeddingModel: args.model,
      })
  },
})
export const pendingIndex = internalQuery({
  args: {},
  handler: async (ctx) =>
    (
      await ctx.db
        .query("indexNotifications")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .take(100)
    ).filter((n) => n.updatedAt <= Date.now() - 30_000),
})
export const indexResult = internalMutation({
  args: {
    ids: v.array(v.id("indexNotifications")),
    sentAt: v.number(),
    success: v.boolean(),
  },
  handler: async (ctx, args) => {
    for (const id of args.ids) {
      const item = await ctx.db.get(id)
      if (item && item.updatedAt <= args.sentAt)
        await ctx.db.patch(id, {
          status: args.success ? "sent" : "pending",
          attempts: item.attempts + 1,
        })
    }
  },
})
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const status of ["running", "retry", "pending"] as const) {
      const rows = await ctx.db
        .query("jobs")
        .withIndex("by_status_next", (q) =>
          q.eq("status", status).lte("nextAt", Date.now())
        )
        .take(20)
      for (const job of rows) {
        if (job.attempts >= 4) {
          await ctx.db.patch(job._id, {
            status: "failed",
            error: "Background attempts exhausted after interruption.",
          })
          continue
        }
        await ctx.db.patch(job._id, { status: "retry", nextAt: Date.now() })
        await ctx.scheduler.runAfter(0, internal.background.run, {
          jobId: job._id,
        })
      }
    }
  },
})
export const recordMetric = internalMutation({
  args: { name: v.string() },
  handler: async (ctx, args) => {
    await metric(ctx, args.name)
  },
})
export const searchBudget = internalMutation({
  args: { count: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const count = args.count ?? 1
    if (!Number.isInteger(count) || count < 1 || count > 4)
      throw new Error("Invalid semantic query count.")
    // Reserve the entire batch atomically before calling the embedding service.
    for (let i = 0; i < count; i++) await rateLimit(ctx, "semantic_search", 120)
  },
})
