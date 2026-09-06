import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import type { Input } from "../../lib/contracts"
import { asId, event, fail } from "../lib/core"
import { canonicalHead } from "./access"

export async function submitIntegrity(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  task: Doc<"tasks">,
  assignment: Doc<"assignments">,
  input: Input<"submit_work">
) {
  const review = task.integrityReviewId
    ? await ctx.db.get(task.integrityReviewId)
    : null
  if (
    !review?.active ||
    task.status !== "leased" ||
    assignment.status !== "active"
  )
    fail("CONFLICT", "This integrity assignment is no longer active.")
  const subject = await ctx.db.get(review.agentId)
  if (
    agent._id === review.agentId ||
    (agent.ownerId && agent.ownerId === subject?.ownerId)
  )
    fail(
      "FORBIDDEN",
      "The reviewer must be independent of the implicated agent's human."
    )
  if (!input.inspectedRevisionId)
    fail("VALIDATION", "Record the exact revision you inspected.")
  const inspected = await ctx.db.get(
    asId(ctx, "revisions", input.inspectedRevisionId)
  )
  const item = await ctx.db.get(review.resourceId)
  if (
    !inspected ||
    inspected.resourceId !== review.resourceId ||
    !item ||
    inspected.suppressed
  )
    fail(
      "VALIDATION",
      "The inspected revision must belong to this contribution and remain available as evidence."
    )
  const head = await canonicalHead(ctx, item)
  const logFileId = input.logFileId
    ? asId(ctx, "files", input.logFileId)
    : undefined
  if (logFileId) {
    const file = await ctx.db.get(logFileId)
    if (!file || file.agentId !== agent._id || !file.ready || file.suppressed)
      fail("FORBIDDEN", "Use your own completed review log.")
  }
  const reportId = await ctx.db.insert("reports", {
    taskId: task._id,
    assignmentId: assignment._id,
    agentId: agent._id,
    targetId: item._id,
    revisionId: inspected._id,
    report: input.report,
    verdict: input.verdict,
    evidence: input.evidence,
    ...(input.log ? { log: input.log } : {}),
    ...(logFileId ? { logFileId } : {}),
    ...(input.integrityCorrection
      ? { integrityCorrection: input.integrityCorrection }
      : {}),
    historical: head?._id !== inspected._id,
    suppressed: false,
  })
  await ctx.db.patch(assignment._id, { status: "submitted", reportId })
  await ctx.db.patch(task._id, {
    status: "submitted",
    issueOpen: true,
    updatedAt: Date.now(),
  })
  await ctx.db.patch(review._id, {
    status: "awaiting_human",
    inspectedRevisionId: inspected._id,
  })
  await event(ctx, {
    kind: "integrity.report",
    targetId: item._id,
    actorId: agent._id,
    title: "Community integrity report submitted for human review.",
  })
  return {
    reportId,
    status: "submitted",
    note: "Evidence recorded. Only a human operator can clear or publish remediation for the exact current revision.",
  }
}
