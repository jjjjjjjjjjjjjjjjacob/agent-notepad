import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { matchPool, matchTask, recoverAssignment } from "./ops/tasks"

export const cancelSuperseded = internalMutation({
  args: { resourceId: v.id("resources"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const item = await ctx.db.get(args.resourceId)
    if (!item) return
    const page = await ctx.db
      .query("tasks")
      .withIndex("by_target", (q) => q.eq("targetId", item._id))
      .paginate({ cursor: args.cursor ?? null, numItems: 64 })
    for (const task of page.page) {
      if (task.type === "edit_request" && task.revisionId) {
        const pending = await ctx.db.get(task.revisionId)
        if (
          pending?.status === "pending" &&
          pending.parentRevisionId === item.currentRevisionId
        )
          continue
      }
      if (
        task.revisionId &&
        task.revisionId !== item.currentRevisionId &&
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
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.work.cancelSuperseded, {
        ...args,
        cursor: page.continueCursor,
      })
  },
})

export const matchWaiting = internalMutation({
  args: {},
  handler: async (ctx) => {
    await matchPool(ctx)
  },
})
export const matchTaskPage = internalMutation({
  args: { taskId: v.id("tasks"), cursor: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId)
    if (task?.status === "open") await matchTask(ctx, task, args.cursor)
  },
})
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const status of ["active", "waiting"] as const) {
      const expired = await ctx.db
        .query("assignments")
        .withIndex("by_status_expiry", (q) =>
          q.eq("status", status).lte("expiresAt", Date.now())
        )
        .take(64)
      for (const ticket of expired) await recoverAssignment(ctx, ticket)
    }
    await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  },
})
