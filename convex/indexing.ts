import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import {
  batchState,
  finishBatch,
  requestBatch,
  scheduleBatch,
} from "./lib/batches"
import { indexSnapshot } from "./lib/indexQueue"

export const request = internalMutation({
  args: {},
  handler: (ctx) => requestBatch(ctx, "indexnow"),
})

export const flush = internalMutation({
  args: { generation: v.number() },
  handler: async (ctx, { generation }) => {
    const batch = await batchState(ctx, "indexnow")
    if (!batch || batch.generation !== generation || !batch.scheduledId) return
    if (
      !process.env.INDEXNOW_KEY ||
      !process.env.SITE_URL?.startsWith("https://")
    ) {
      await finishBatch(ctx, batch)
      return
    }
    const pending = await ctx.db
      .query("indexNotifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .take(100)
    const rows = pending.filter((row) => row.attempts < 4)
    for (const row of pending)
      await ctx.db.patch(
        row._id,
        row.attempts >= 4
          ? { status: "failed" }
          : { attempts: row.attempts + 1 }
      )
    if (!rows.length) {
      if (pending.length === 100) await scheduleBatch(ctx, batch, 1000)
      else await finishBatch(ctx, batch)
      return
    }
    const scheduledId = await ctx.scheduler.runAfter(
      0,
      internal.background.indexNow,
      {
        generation,
        rows: rows.map((row) => ({
          id: row._id,
          url: row.url,
          updatedAt: row.updatedAt,
          version: row.version ?? 0,
        })),
      }
    )
    // Replaced only after this action fails or exceeds its bounded HTTP timeout.
    await ctx.db.patch(batch._id, { scheduledId, nextAt: Date.now() + 120_000 })
  },
})

export const complete = internalMutation({
  args: {
    generation: v.number(),
    rows: v.array(indexSnapshot),
    success: v.boolean(),
    terminal: v.boolean(),
  },
  handler: async (ctx, args) => {
    const batch = await batchState(ctx, "indexnow")
    if (!batch || batch.generation !== args.generation || !batch.scheduledId)
      return
    let attempts = 0
    for (const sent of args.rows) {
      const item = await ctx.db.get(sent.id)
      if (
        !item ||
        (item.version ?? 0) !== sent.version ||
        item.updatedAt !== sent.updatedAt
      )
        continue
      attempts = Math.max(attempts, item.attempts)
      await ctx.db.patch(item._id, {
        status: args.success
          ? "sent"
          : args.terminal || item.attempts >= 4
            ? "failed"
            : "pending",
      })
    }
    const pending = await ctx.db
      .query("indexNotifications")
      .withIndex("by_status", (q) => q.eq("status", "pending"))
      .first()
    console.info("maintenance.indexnow", {
      count: args.rows.length,
      success: args.success,
      attempts,
      pending: !!pending,
    })
    if (pending)
      await scheduleBatch(
        ctx,
        batch,
        args.success || args.terminal
          ? 1000
          : Math.min(60_000 * 2 ** attempts, 30 * 60_000) +
              Math.floor(Math.random() * 15_000)
      )
    else await finishBatch(ctx, batch)
  },
})
