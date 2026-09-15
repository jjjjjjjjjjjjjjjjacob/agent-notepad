import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import {
  matchPool,
  matchPoolPage as continueMatchPool,
  matchTask,
  recoverAssignment,
} from "./ops/tasks"
import { legacyTaskCopy } from "./moderation/taskVisibility"
import {
  batchState,
  batchSignal,
  beginPass,
  finishBatch,
  requestBatch,
  scheduleBatch,
} from "./lib/batches"
import { armLease } from "./lib/leaseTimers"

// Compatibility readers already withhold these records. Cleanup never guesses
// source attribution from matching text, and can be resumed after interruption.
export const retireLegacyTaskCopies = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("tasks")
      .paginate({ cursor: args.cursor ?? null, numItems: 50 })
    for (const task of page.page) {
      if (!legacyTaskCopy(task)) continue
      await ctx.db.patch(task._id, {
        title: "Retired task without source attribution",
        description: "",
        status: "cancelled",
        issueOpen: false,
        updatedAt: Date.now(),
      })
      if (task.assignmentId) {
        const assignment = await ctx.db.get(task.assignmentId)
        if (assignment?.status === "active")
          await ctx.db.patch(assignment._id, { status: "cancelled" })
        if (assignment?.status === "active") await requestBatch(ctx, "matching")
      }
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.work.retireLegacyTaskCopies, {
        cursor: page.continueCursor,
      })
    return {
      complete: page.isDone,
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

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
        !task.integrityReviewId &&
        task.revisionId !== item.currentRevisionId &&
        ["open", "leased"].includes(task.status)
      ) {
        await ctx.db.patch(task._id, {
          status: "cancelled",
          updatedAt: Date.now(),
        })
        if (task.assignmentId) {
          await ctx.db.patch(task.assignmentId, { status: "cancelled" })
          await requestBatch(ctx, "matching")
        }
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
  args: { generation: v.optional(v.number()) },
  handler: async (ctx, args) => {
    // Old scheduled callbacks and direct operator calls remain compatible.
    if (args.generation === undefined) {
      await matchPool(ctx)
      await requestBatch(ctx, "matching")
      return
    }
    const batch = await batchState(ctx, "matching")
    if (!batch || batch.generation !== args.generation || !batch.scheduledId)
      return
    const waiting = await ctx.db
      .query("assignments")
      .withIndex("by_status_expiry", (q) =>
        q.eq("status", "waiting").gt("expiresAt", Date.now())
      )
      .first()
    if (!waiting) {
      await finishBatch(ctx, batch)
      return
    }
    const pass = batch.matching ?? {
      version: await beginPass(ctx, batch),
      pivot: Math.random(),
      phase: "after" as const,
      tasks: [],
      done: false,
    }
    if (!pass.tasks.length && !pass.done) {
      const query = ctx.db
        .query("tasks")
        .withIndex("by_status_random", (q) =>
          pass.phase === "after"
            ? q.eq("status", "open").gte("random", pass.pivot)
            : q.eq("status", "open").lt("random", pass.pivot)
        )
      const page = await query.paginate({
        cursor: pass.cursor ?? null,
        numItems: 12,
      })
      pass.tasks = page.page.filter((t) => !t.committeeCaseId).map((t) => t._id)
      pass.cursor = page.continueCursor
      pass.done = page.isDone
    } else if (pass.tasks.length) {
      // Convex permits one paginated query per mutation. A task page and its
      // FIFO assignment page therefore execute in separate continuations.
      const task = await ctx.db.get(pass.tasks[0])
      const cursor = task
        ? await matchTask(ctx, task, pass.assignmentCursor, undefined, false)
        : undefined
      pass.assignmentCursor = cursor
      if (cursor === undefined) pass.tasks.shift()
    }
    if (!pass.tasks.length && pass.done) {
      if (pass.phase === "after") {
        pass.phase = "before"
        pass.cursor = undefined
        pass.done = false
      } else {
        await ctx.db.patch(batch._id, {
          matching: undefined,
          scheduledId: undefined,
        })
        const signal = await batchSignal(ctx, "matching")
        if ((signal?.version ?? batch.version) > pass.version)
          await scheduleBatch(ctx, batch, 100)
        else await finishBatch(ctx, batch)
        return
      }
    }
    await ctx.db.patch(batch._id, { matching: pass })
    await scheduleBatch(ctx, batch, 25)
  },
})
export const expireLease = internalMutation({
  args: { assignmentId: v.id("assignments"), generation: v.number() },
  handler: async (ctx, { assignmentId, generation }) => {
    const lease = await ctx.db.get(assignmentId)
    if (
      !lease ||
      lease.expiryGeneration !== generation ||
      !["waiting", "active"].includes(lease.status)
    )
      return
    await ctx.db.patch(lease._id, { expiryScheduledId: undefined })
    if (lease.expiresAt > Date.now()) {
      await armLease(ctx, { ...lease, expiryScheduledId: undefined })
      return
    }
    await recoverAssignment(ctx, lease)
    await requestBatch(ctx, "matching")
  },
})
export const matchTaskPage = internalMutation({
  args: { taskId: v.id("tasks"), cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId)
    if (task?.status === "open") await matchTask(ctx, task, args.cursor)
  },
})
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    let recovered = 0
    let more = false
    for (const status of ["active", "waiting"] as const) {
      const expired = await ctx.db
        .query("assignments")
        .withIndex("by_status_expiry", (q) =>
          q.eq("status", status).lte("expiresAt", Date.now())
        )
        .take(64)
      for (const ticket of expired) {
        await recoverAssignment(ctx, ticket)
        recovered++
      }
      const legacy = await ctx.db
        .query("assignments")
        .withIndex("by_status_timer", (q) =>
          q.eq("status", status).eq("expiryGeneration", undefined)
        )
        .take(32)
      for (const ticket of legacy) await armLease(ctx, ticket)
      more ||= expired.length === 64 || legacy.length === 32
    }
    if (more) await ctx.scheduler.runAfter(100, internal.work.recover, {})
    if (recovered) await requestBatch(ctx, "matching")
  },
})

export const matchPoolPage = internalMutation({
  args: {
    pivot: v.number(),
    phase: v.union(v.literal("after"), v.literal("before")),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, { pivot, phase, cursor }) =>
    continueMatchPool(ctx, pivot, phase, cursor),
})
