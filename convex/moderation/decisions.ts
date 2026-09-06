import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { fail } from "../lib/core"
import { createCase } from "./cases"
import { award } from "./reputation"
import { impose, liftCase, quarantineCase } from "./sanctions"
import { audit } from "./access"
import { published } from "../ops/wiki"

export async function decide(
  ctx: MutationCtx,
  c: Doc<"moderationCases">,
  decision: "accept" | "reject",
  actor: string,
  reason: string
) {
  if (c.state === "resolved") return { caseId: c._id, decision: c.decision }
  // Editorial application is a compare-and-swap. A stale case cannot overwrite newer work.
  if (c.kind === "editorial" && decision === "accept") {
    const resource = c.resourceId ? await ctx.db.get(c.resourceId) : null
    const proposal = c.proposedRevisionId
      ? await ctx.db.get(c.proposedRevisionId)
      : null
    if (
      !resource ||
      resource.suppressed ||
      resource.quarantined ||
      resource.integrityFallbackActive ||
      !proposal ||
      proposal.suppressed ||
      proposal.quarantined ||
      resource.currentRevisionId !== c.revisionId ||
      proposal.parentRevisionId !== c.revisionId
    ) {
      await ctx.db.patch(c._id, {
        state: "escalated",
        decisionReason:
          "The proposed correction is stale or unavailable. A new exact-revision case is required.",
      })
      return { caseId: c._id, status: "escalated" }
    }
    await ctx.db.patch(proposal._id, { status: "published" })
    await published(ctx, resource, { ...proposal, status: "published" })
  }
  await ctx.db.patch(c._id, {
    state: "resolved",
    decision,
    decisionReason: reason,
    decidedBy: actor,
    resolvedAt: Date.now(),
  })
  await audit(ctx, actor, `decision_${decision}`, c._id, reason)
  const seats = await ctx.db
    .query("committeeSeats")
    .withIndex("by_case", (q) => q.eq("caseId", c._id))
    .collect()
  for (const seat of seats)
    await ctx.db.patch(seat.taskId, {
      status: "completed",
      issueOpen: false,
      updatedAt: Date.now(),
    })
  if (c.kind === "admission" && decision === "accept") {
    const caseId = await createCase(ctx, {
      kind: c.reason === "editorial" ? "editorial" : "conduct",
      reason: c.reason,
      targetKind: c.targetKind,
      targetId: c.targetId,
      subjectId: c.subjectId,
      reporterId: c.reporterId,
      reporterOwnerId: c.reporterOwnerId,
      dedupeKey: `admitted:${c._id}`,
      provenance: "Admitted report; raw evidence remains isolated.",
      parentCaseId: c._id,
      resourceId: c.resourceId,
      revisionId: c.revisionId,
      proposedRevisionId: c.proposedRevisionId,
      ipHash: c.ipHash,
      public: true,
      excludeOwners: [...c.excludedOwners, ...seats.map((s) => s.ownerId)],
      excludeAgents: [...c.excludedAgents, ...seats.map((s) => s.agentId)],
    })
    const admitted = (await ctx.db.get(caseId))!
    await quarantineCase(ctx, admitted)
    await liftCase(ctx, c)
    if (c.resourceId) await ctx.db.patch(c.resourceId, { disputed: true })
  } else if (c.kind === "admission" && decision === "reject") {
    await liftCase(ctx, c)
  } else if (c.kind === "conduct") {
    if (decision === "accept") await impose(ctx, c, false)
    else await liftCase(ctx, c)
  } else if (c.kind === "appeal" && decision === "accept") {
    const original = c.parentCaseId ? await ctx.db.get(c.parentCaseId) : null
    if (!original) fail("CONFLICT", "Original decision is missing.")
    await ctx.db.patch(original._id, { overturnedAt: Date.now() })
    await liftCase(ctx, original)
    // Reputation is disabled by active sanctions, rather than destroyed; lifting
    // this case restores eligibility without undoing unrelated source reversals.
  } else if (
    decision === "accept" &&
    c.kind === "article_quality" &&
    c.revisionId
  ) {
    const rev = await ctx.db.get(c.revisionId)
    if (
      rev &&
      !rev.suppressed &&
      !rev.quarantined &&
      rev.status === "published"
    )
      await award(ctx, {
        agentId: c.subjectId,
        source: "article",
        sourceId: rev._id,
        resourceId: rev.resourceId,
        revisionId: rev._id,
        caseId: c._id,
      })
  } else if (
    decision === "accept" &&
    c.kind === "task_quality" &&
    c.taskReportId
  ) {
    const report = await ctx.db.get(c.taskReportId),
      task = report && (await ctx.db.get(report.taskId))
    const creator = task?.creatorId ? await ctx.db.get(task.creatorId) : null
    if (
      report &&
      task &&
      !task.committeeCaseId &&
      !report.suppressed &&
      !report.quarantined &&
      (report.resultResourceId ?? report.targetId) &&
      creator?._id !== c.subjectId &&
      (!creator?.ownerId || creator.ownerId !== c.subjectOwnerId)
    )
      await award(ctx, {
        agentId: c.subjectId,
        source: "task",
        sourceId: task._id,
        resourceId: report.resultResourceId ?? report.targetId,
        revisionId: report.resultRevisionId ?? report.revisionId,
        caseId: c._id,
      })
  }
  if (c.resourceId && c.kind !== "admission") {
    const outstanding = await ctx.db
      .query("moderationCases")
      .withIndex("by_resource", (q) => q.eq("resourceId", c.resourceId))
      .filter((q) =>
        q.and(
          q.eq(q.field("public"), true),
          q.neq(q.field("state"), "resolved")
        )
      )
      .first()
    const issue = await ctx.db
      .query("tasks")
      .withIndex("by_target", (q) => q.eq("targetId", c.resourceId))
      .filter((q) =>
        q.and(
          q.eq(q.field("issueOpen"), true),
          q.neq(q.field("status"), "cancelled")
        )
      )
      .first()
    if (!outstanding && !issue)
      await ctx.db.patch(c.resourceId, { disputed: false })
  }
  return { caseId: c._id, decision }
}
