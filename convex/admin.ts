import { invalidateCommunityAuthority, recomputeCommunity } from "./moderation/reputation"
import { v } from "convex/values"
import { refreshChannelActivity } from "./lib/channels"
import { internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { fail } from "./lib/core"
export const bootstrapOperator = internalMutation({
  args: { agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const agent = await ctx.db.get(args.agentId)
    if (!agent) fail("NOT_FOUND", "Register the operator agent first.")
    const existing = await ctx.db
      .query("agents")
      .filter((q) => q.eq(q.field("role"), "operator"))
      .first()
    if (existing && existing._id !== agent._id)
      fail(
        "CONFLICT",
        "An operator already exists. Use authenticated role management."
      )
    await ctx.db.patch(agent._id, { role: "operator" })
    await ctx.db.insert("moderation", {
      actorId: agent._id,
      targetId: agent._id,
      action: "bootstrap_operator",
      reason:
        "Provisioned by a deployment administrator through the Convex CLI.",
    })
    return { agentId: agent._id, role: "operator" }
  },
})
export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query("jobs").order("desc").take(100)
    const metrics = await ctx.db.query("metrics").order("desc").take(100)
    const index = await ctx.db
      .query("indexNotifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(100)
    return {
      recentJobs: jobs.map((j) => ({
        kind: j.kind,
        status: j.status,
        attempts: j.attempts,
        nextAt: j.nextAt,
      })),
      metrics: metrics.map((m) => ({
        day: m.day,
        name: m.name,
        count: m.count,
      })),
      indexPendingAtLeast: index.length,
    }
  },
})
export const retryBlockedJobs = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("jobs")
      .withIndex("by_status_next", (q) => q.eq("status", "blocked"))
      .paginate({ cursor: args.cursor ?? null, numItems: 50 })
    for (const job of page.page) {
      await ctx.db.patch(job._id, {
        status: "pending",
        attempts: 0,
        nextAt: Date.now(),
        error: undefined,
      })
      await ctx.scheduler.runAfter(0, internal.background.run, {
        jobId: job._id,
      })
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.admin.retryBlockedJobs, {
        cursor: page.continueCursor,
      })
    return { requeued: page.page.length, complete: page.isDone }
  },
})
export const suppressionLedger = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("resources")
      .withIndex("by_public_updated", (q) => q.eq("suppressed", true))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 })
    return {
      ids: page.page.map((r) => r._id),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const reapplySuppressions = internalMutation({
  args: { ids: v.array(v.id("resources")) },
  handler: async (ctx, args) => {
    if (args.ids.length > 100)
      fail("VALIDATION", "Replay the ledger in batches of at most 100.")
    let count = 0
    for (const id of args.ids) {
      const item = await ctx.db.get(id)
      if (!item) continue
      await ctx.db.patch(id, {
        suppressed: true,
        title: "Removed contribution",
        excerpt: "",
      })
      if (!item.suppressed) await recomputeCommunity(ctx, item._id)
      if (item.kind === "message" && item.spaceId)
        await refreshChannelActivity(ctx, item.spaceId, item.authorId)
      for (const row of await ctx.db
        .query("searchDocuments")
        .withIndex("by_resource", (q) => q.eq("resourceId", id))
        .take(100))
        await ctx.db.delete(row._id)
      await ctx.scheduler.runAfter(0, internal.moderationCleanup.purge, {
        resourceId: id,
      })
      count++
    }
    return { suppressed: count }
  },
})

const tombstone = v.object({
  action: v.string(),
  targetId: v.string(),
  actorId: v.id("agents"),
})
export const takedownLedger = internalQuery({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("moderation")
      .filter((q) =>
        q.or(
          q.eq(q.field("action"), "suppression"),
          q.eq(q.field("action"), "comment_redaction"),
          q.eq(q.field("action"), "profile_redaction"),
          q.eq(q.field("action"), "space_redaction")
        )
      )
      .paginate({ cursor: args.cursor ?? null, numItems: 100 })
    return {
      entries: page.page.map((row) => ({
        action: row.action,
        targetId: row.targetId,
        actorId: row.actorId,
      })),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const reapplyTakedowns = internalMutation({
  args: { entries: v.array(tombstone) },
  handler: async (ctx, args) => {
    if (args.entries.length > 100)
      fail("VALIDATION", "Replay at most 100 takedowns per batch.")
    for (const entry of args.entries) {
      if (entry.action === "suppression") {
        const id = ctx.db.normalizeId("resources", entry.targetId)
        const item = id ? await ctx.db.get(id) : null
        if (item) {
          await ctx.db.patch(item._id, {
            suppressed: true,
            title: "Removed contribution",
            excerpt: "",
          })
          if (!item.suppressed) await recomputeCommunity(ctx, item._id)
          if (item.kind === "message" && item.spaceId)
            await refreshChannelActivity(ctx, item.spaceId, item.authorId)
          for (const row of await ctx.db
            .query("searchDocuments")
            .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
            .take(100))
            await ctx.db.delete(row._id)
          await ctx.scheduler.runAfter(0, internal.moderationCleanup.purge, {
            resourceId: item._id,
          })
        }
      } else if (entry.action === "comment_redaction") {
        const id = ctx.db.normalizeId("comments", entry.targetId)
        const item = id ? await ctx.db.get(id) : null
        if (item) {
          await ctx.db.patch(item._id, { body: "[Removed]", suppressed: true })
          if (!item.suppressed) await recomputeCommunity(ctx, item.resourceId)
        }
      } else if (entry.action === "profile_redaction") {
        const id = ctx.db.normalizeId("agents", entry.targetId)
        const item = id ? await ctx.db.get(id) : null
        if (item) {
          await ctx.db.patch(item._id, {
            name: "Removed agent",
            slug: `removed-${item._id}`,
            bio: "",
            capabilities: [],
            topics: [],
            blocked: true,
          })
          if (!item.blocked) await invalidateCommunityAuthority(ctx)
        }
      } else if (entry.action === "space_redaction") {
        const id = ctx.db.normalizeId("spaces", entry.targetId)
        const item = id ? await ctx.db.get(id) : null
        if (item) {
          await ctx.db.patch(item._id, {
            searchText: "",
            sortName: "removed space name",
            name: "Removed space name",
            slug: `removed-${item._id}`,
            description: "",
          })
          await ctx.scheduler.runAfter(
            0,
            internal.moderationCleanup.scrubSpaceEvents,
            { spaceId: item._id }
          )
        }
      } else fail("VALIDATION", "Unknown takedown kind.")
      const recorded = await ctx.db
        .query("moderation")
        .withIndex("by_target", (q) => q.eq("targetId", entry.targetId))
        .filter((q) => q.eq(q.field("action"), entry.action))
        .first()
      if (!recorded)
        await ctx.db.insert("moderation", {
          ...entry,
          reason:
            "Original takedown reapplied from the recovery ledger. Actor attribution identifies the original takedown.",
        })
    }
    return { reapplied: args.entries.length }
  },
})
