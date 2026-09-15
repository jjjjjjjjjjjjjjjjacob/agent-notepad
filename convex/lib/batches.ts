import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { internal } from "../_generated/api"

export type BatchName = "matching" | "indexnow"
export const batchState = (ctx: MutationCtx, name: BatchName) =>
  ctx.db
    .query("maintenanceBatches")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique()

export const batchSignal = (ctx: MutationCtx, name: BatchName) =>
  ctx.db
    .query("maintenanceSignals")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique()

export async function beginPass(
  ctx: MutationCtx,
  batch: Doc<"maintenanceBatches">
) {
  const signal = await batchSignal(ctx, batch.name)
  if (signal) await ctx.db.patch(signal._id, { dirty: false })
  return signal?.version ?? batch.version
}

export async function finishBatch(
  ctx: MutationCtx,
  batch: Doc<"maintenanceBatches">
) {
  await ctx.db.patch(batch._id, { scheduledId: undefined, matching: undefined })
  const signal = await batchSignal(ctx, batch.name)
  if (signal) await ctx.db.patch(signal._id, { pending: false, dirty: false })
}

export async function scheduleBatch(
  ctx: MutationCtx,
  batch: Doc<"maintenanceBatches">,
  delay: number
) {
  const generation = batch.generation + 1
  const scheduledId = await ctx.scheduler.runAfter(
    delay,
    batch.name === "matching"
      ? internal.work.matchWaiting
      : internal.indexing.flush,
    { generation }
  )
  await ctx.db.patch(batch._id, {
    generation,
    scheduledId,
    nextAt: Date.now() + delay,
  })
}

// One durable signal per domain. Producers never postpone an existing flush.
export async function requestBatch(
  ctx: MutationCtx,
  name: BatchName,
  delay = name === "matching" ? 100 : 60_000
) {
  if (
    name === "indexnow" &&
    (!process.env.INDEXNOW_KEY || !process.env.SITE_URL?.startsWith("https://"))
  )
    return
  // Producers never read the hot progress row while work is pending. A single
  // dirty edge covers the entire burst; per-page progress cannot invalidate
  // every in-flight user mutation through a shared-row OCC conflict.
  let signal = await batchSignal(ctx, name)
  if (!signal) {
    const current = await batchState(ctx, name)
    const id = await ctx.db.insert("maintenanceSignals", {
      name,
      version: (current?.version ?? 0) + 1,
      pending: !!current?.scheduledId,
      dirty: true,
    })
    signal = (await ctx.db.get(id))!
  }
  if (signal.pending) {
    if (!signal.dirty)
      await ctx.db.patch(signal._id, {
        dirty: true,
        version: signal.version + 1,
      })
    return
  }
  let batch = await batchState(ctx, name)
  if (!batch) {
    const id = await ctx.db.insert("maintenanceBatches", {
      name,
      version: 0,
      generation: 0,
      nextAt: 0,
    })
    batch = (await ctx.db.get(id))!
  }
  await ctx.db.patch(signal._id, {
    pending: true,
    dirty: true,
    version: signal.version + 1,
  })
  await scheduleBatch(ctx, batch, delay)
}

export async function cancelPending(
  ctx: MutationCtx,
  id: Doc<"maintenanceBatches">["scheduledId"]
) {
  if (!id) return
  const call = await ctx.db.system.get(id)
  if (call?.state.kind === "pending") await ctx.scheduler.cancel(id)
}
