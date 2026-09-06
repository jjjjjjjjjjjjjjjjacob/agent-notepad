import { recomputeCommunity } from "./moderation/reputation"
import { refreshChannelActivity } from "./lib/channels"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import type { MutationCtx } from "./_generated/server"
import type { Id } from "./_generated/dataModel"
import { v } from "convex/values"
async function removeFile(ctx: MutationCtx, id: Id<"files">) {
  const file = await ctx.db.get(id)
  if (file?.storageId && !file.suppressed)
    await ctx.storage.delete(file.storageId)
  if (file)
    await ctx.db.patch(file._id, { suppressed: true, filename: "Removed file" })
}
export const purge = internalMutation({
  args: {
    resourceId: v.id("resources"),
    cursor: v.optional(v.string()),
    phase: v.optional(
      v.union(
        v.literal("revisions"),
        v.literal("comments"),
        v.literal("tasks"),
        v.literal("reports"),
        v.literal("events")
      )
    ),
  },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.resourceId)
    if (!item?.suppressed) return
    if (!args.phase) await recomputeCommunity(ctx, item._id)
    if (!args.phase && item.kind === "wiki") {
      for (const link of await ctx.db.query("wikiLinks").withIndex("by_source", q => q.eq("sourceId", item._id)).take(101))
        await ctx.db.delete(link._id)
      await ctx.db.patch(item._id, { wikiStats: undefined })
    }
    if (!args.phase && item.kind === "message" && item.spaceId)
      await refreshChannelActivity(ctx, item.spaceId, item.authorId)
    const phase = args.phase ?? "revisions"
    const options = { cursor: args.cursor ?? null, numItems: 32 }
    let next: string | undefined
    if (phase === "revisions") {
      const page = await ctx.db
        .query("revisions")
        .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
        .paginate(options)
      for (const rev of page.page) {
        for (const fileId of rev.attachmentIds) await removeFile(ctx, fileId)
        for (const source of await ctx.db
          .query("sources")
          .withIndex("by_revision", (q) => q.eq("revisionId", rev._id))
          .take(30))
          await ctx.db.delete(source._id)
        await ctx.db.patch(rev._id, {
          body: "[Removed]",
          title: "Removed contribution",
          summary: "[Removed]",
          citations: [],
          attachmentIds: [],
          suppressed: true,
          reviewReason: undefined,
        })
      }
      if (!page.isDone) next = page.continueCursor
    } else if (phase === "comments") {
      const page = await ctx.db
        .query("comments")
        .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
        .paginate(options)
      for (const row of page.page)
        await ctx.db.patch(row._id, { body: "[Removed]", suppressed: true })
      if (!page.isDone) next = page.continueCursor
    } else if (phase === "tasks") {
      const page = await ctx.db
        .query("tasks")
        .withIndex("by_target", (q) => q.eq("targetId", item._id))
        .paginate(options)
      for (const row of page.page) {
        await ctx.db.patch(row._id, {
          status: "cancelled",
          title: "Removed contribution",
          description: "[Removed]",
          issueOpen: false,
        })
        if (row.assignmentId)
          await ctx.db.patch(row.assignmentId, { status: "cancelled" })
      }
      if (!page.isDone) next = page.continueCursor
    } else if (phase === "reports") {
      const page = await ctx.db
        .query("reports")
        .withIndex("by_target", (q) => q.eq("targetId", item._id))
        .paginate(options)
      for (const row of page.page) {
        if (row.logFileId) await removeFile(ctx, row.logFileId)
        await ctx.db.patch(row._id, {
          suppressed: true,
          report: "[Removed]",
          evidence: [],
          log: undefined,
        })
      }
      if (!page.isDone) next = page.continueCursor
    } else {
      const page = await ctx.db
        .query("events")
        .withIndex("by_target", (q) => q.eq("targetId", item._id))
        .paginate(options)
      for (const row of page.page)
        await ctx.db.patch(row._id, {
          suppressed: true,
          title: "Removed contribution",
        })
      if (!page.isDone) next = page.continueCursor
    }
    if (next)
      await ctx.scheduler.runAfter(0, internal.moderationCleanup.purge, {
        resourceId: item._id,
        phase,
        cursor: next,
      })
    else {
      const phases = [
        "revisions",
        "comments",
        "tasks",
        "reports",
        "events",
      ] as const
      const nextPhase = phases[phases.indexOf(phase) + 1]
      if (nextPhase)
        await ctx.scheduler.runAfter(0, internal.moderationCleanup.purge, {
          resourceId: item._id,
          phase: nextPhase,
        })
    }
  },
})

export const scrubSpaceEvents = internalMutation({
  args: { spaceId: v.id("spaces"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_target", (q) => q.eq("targetId", args.spaceId))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 })
    for (const row of page.page)
      await ctx.db.patch(row._id, {
        title: "Removed space name",
        suppressed: true,
      })
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        0,
        internal.moderationCleanup.scrubSpaceEvents,
        { ...args, cursor: page.continueCursor }
      )
  },
})
