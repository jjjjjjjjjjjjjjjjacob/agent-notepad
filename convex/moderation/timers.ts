import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { cancelPending } from "../lib/batches"

export async function queueRound(
  ctx: MutationCtx,
  c: Doc<"moderationCases">,
  dueAt = Date.now()
) {
  const current = await ctx.db.get(c._id)
  if (!current || !["queued", "seating", "voting"].includes(current.state))
    return
  if (current.roundJobPending) {
    if (current.roundJobScheduledId) {
      const call = await ctx.db.system.get(current.roundJobScheduledId)
      if (
        call?.state.kind === "pending" &&
        (current.roundJobDueAt ?? 0) <= dueAt
      )
        return
    } else if ((current.roundJobScheduledAt ?? 0) > Date.now() - 5 * 60_000)
      return
  }
  await cancelPending(ctx, current.roundJobScheduledId)
  await cancelPending(ctx, current.roundRecoveryId)
  const generation = (current.roundJobVersion ?? 0) + 1
  const roundJobScheduledId = await ctx.scheduler.runAt(
    dueAt,
    internal.governance.continueCase,
    { caseId: c._id, generation }
  )
  // This check runs only for an actual case, before the late-closure grace ends.
  const roundRecoveryId = await ctx.scheduler.runAt(
    Math.max(Date.now(), dueAt) + 60_000,
    internal.governance.checkWake,
    { caseId: c._id, generation }
  )
  await ctx.db.patch(c._id, {
    roundJobPending: true,
    roundJobVersion: generation,
    roundJobScheduledAt: Date.now(),
    roundJobDueAt: dueAt,
    roundJobScheduledId,
    roundRecoveryId,
  })
}

export async function armCaseDeadline(
  ctx: MutationCtx,
  caseId: Id<"moderationCases">
) {
  const c = await ctx.db.get(caseId)
  if (!c) return
  if (!["queued", "seating", "voting"].includes(c.state)) {
    await cancelPending(ctx, c.roundJobScheduledId)
    await cancelPending(ctx, c.roundRecoveryId)
    await ctx.db.patch(c._id, {
      roundJobPending: false,
      roundJobScheduledId: undefined,
      roundRecoveryId: undefined,
      roundJobDueAt: undefined,
    })
    return
  }
  await queueRound(
    ctx,
    c,
    c.state === "queued"
      ? Math.min(Date.now() + 60_000, c.seatingUntil)
      : c.state === "seating"
        ? c.seatingUntil
        : c.deadline
  )
}
