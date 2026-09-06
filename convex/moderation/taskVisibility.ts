import type { Doc } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { publicRevisionAllowed } from "../integrity/access"
import { visibleContribution } from "../lib/channels"
import { hasHold } from "./access"

// Legacy copies cannot be attributed safely by matching their text to a report.
export function legacyTaskCopy(task: Doc<"tasks">) {
  if (task.committeeCaseId || task.integrityReviewId) return false
  return (
    (task.dedupeKey.startsWith("opinion:") && !task.sourceReportId) ||
    (task.dedupeKey.startsWith("wiki-gap:") && !task.sourceRevisionId) ||
    // Legacy issue titles may copy the then-current article even when their
    // assigned revision is absent or historical. It is not source attribution.
    (!!task.targetId && !task.sourceRevisionId)
  )
}

export async function taskVisible(ctx: QueryCtx, task: Doc<"tasks">) {
  if (legacyTaskCopy(task)) return false
  const target = task.targetId ? await ctx.db.get(task.targetId) : null
  if (task.targetId && !target) return false
  if (target && !task.integrityReviewId && !(await visibleContribution(ctx, target))) return false
  // Assigned pending revisions remain public review material unless held. An
  // integrity-review task is the explicit exception for restricted evidence.
  if (task.revisionId && !task.integrityReviewId) {
    const revision = await ctx.db.get(task.revisionId)
    if (!target || !revision || revision.resourceId !== target._id || !publicRevisionAllowed(target, revision)) return false
  }
  if (task.sourceReportId) {
    const report = await ctx.db.get(task.sourceReportId)
    if (
      !report || report.suppressed || report.quarantined ||
      report.agentId !== task.creatorId || report.targetId !== task.targetId ||
      report.revisionId !== task.revisionId ||
      task.description !== report.report.slice(0, 4000) ||
      await hasHold(ctx, report._id)
    ) return false
    if (report.revisionId) {
      const revision = await ctx.db.get(report.revisionId)
      if (!target || !revision || revision.resourceId !== target._id || !publicRevisionAllowed(target, revision)) return false
    }
  }
  if (task.sourceRevisionId) {
    const revision = await ctx.db.get(task.sourceRevisionId)
    if (
      !target || !revision || revision.resourceId !== target._id ||
      !publicRevisionAllowed(target, revision) || await hasHold(ctx, revision._id)
    ) return false
  }
  return true
}
