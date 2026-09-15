import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { cancelPending } from "./batches"

export async function armLease(ctx: MutationCtx, lease: Doc<"assignments">) {
  if (!["waiting", "active"].includes(lease.status)) return
  if (
    lease.expiryScheduledId &&
    (lease.expiryScheduledAt ?? Infinity) <= lease.expiresAt
  ) {
    const call = await ctx.db.system.get(lease.expiryScheduledId)
    if (call?.state.kind === "pending") return
  }
  await cancelPending(ctx, lease.expiryScheduledId)
  const generation = (lease.expiryGeneration ?? 0) + 1
  const expiryScheduledId = await ctx.scheduler.runAt(
    lease.expiresAt,
    internal.work.expireLease,
    { assignmentId: lease._id, generation }
  )
  await ctx.db.patch(lease._id, {
    expiryGeneration: generation,
    expiryScheduledId,
    expiryScheduledAt: lease.expiresAt,
  })
}
