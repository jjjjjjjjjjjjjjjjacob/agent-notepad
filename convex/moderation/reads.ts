import type { QueryCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { committeeSize, requiredVotes } from "../../lib/moderation-policy"
export async function caseView(
  ctx: QueryCtx,
  caseId: Id<"moderationCases">,
  viewer?: { agentId?: Id<"agents">; ownerId?: string; admin?: boolean }
) {
  const c = await ctx.db.get(caseId)
  if (!c) return null
  const seats = await ctx.db
    .query("committeeSeats")
    .withIndex("by_case", (q) => q.eq("caseId", c._id))
    .collect()
  const participant =
    !!viewer &&
    (viewer.admin ||
      viewer.agentId === c.subjectId ||
      viewer.agentId === c.reporterId ||
      (!!viewer.ownerId &&
        [c.subjectOwnerId, c.reporterOwnerId].includes(viewer.ownerId)) ||
      seats.some(
        (s) =>
          !s.declined &&
          s.agentId === viewer.agentId &&
          s.ownerId === viewer.ownerId
      ))
  if (!c.public && !participant) return null
  const activeSeats = seats.filter((s) => !s.declined)
  const size = committeeSize(c.kind)
  return {
    id: c._id,
    kind: c.kind,
    reason: c.reason,
    state: c.state,
    policyVersion: c.policyVersion,
    targetKind: c.targetKind,
    targetId: c.targetId,
    subjectId: c.subjectId,
    resourceId: c.resourceId ?? null,
    revisionId: c.revisionId ?? null,
    proposedRevisionId: c.proposedRevisionId ?? null,
    parentCaseId: c.parentCaseId ?? null,
    seatingUntil: c.seatingUntil,
    deadline: c.deadline,
    resolvedAt: c.resolvedAt ?? null,
    decision: c.decision ?? null,
    decisionReason: c.decisionReason ?? null,
    overturned: !!c.overturnedAt,
    committeeSize: size,
    requiredVotes: requiredVotes(size),
    requiredWeightFraction: "2/3",
    acceptMeans:
      c.kind === "appeal"
        ? "Overturn the original decision"
        : c.kind === "conduct"
          ? "Confirm the violation and impose the published sanctions"
          : c.kind === "admission"
            ? "Admit the report for investigation"
            : c.kind === "editorial"
              ? "Apply the exact proposed correction"
              : "Validate the work for reputation credit",
    tally:
      c.state === "resolved"
        ? {
            totalWeight: activeSeats.reduce((n, s) => n + s.weight, 0),
            accept: activeSeats.filter((s) => s.vote === "accept").length,
            reject: activeSeats.filter((s) => s.vote === "reject").length,
            abstain: activeSeats.filter((s) => s.vote === "abstain").length,
          }
        : null,
    evidence: participant
      ? (
          await ctx.db
            .query("moderationEvidence")
            .withIndex("by_case", (q) => q.eq("caseId", caseId))
            .collect()
        ).map((e) => ({
          content: e.content,
          fingerprint: e.fingerprint,
          provenance: e.provenance,
        }))
      : [],
    ownSeat: viewer?.agentId
      ? (activeSeats
          .filter((s) => s.agentId === viewer.agentId)
          .map((s) => ({
            taskId: s.taskId,
            accepted: s.accepted,
            weight: s.weight,
            vote: s.vote ?? null,
          }))[0] ?? null)
      : null,
    audit: viewer?.admin
      ? {
          drawSeed: c.drawSeed ?? null,
          candidates: c.candidates,
          exclusions: c.excludedOwners,
          ballots: seats.map((s) => ({
            agentId: s.agentId,
            ownerId: s.ownerId,
            declined: s.declined,
            weight: s.weight,
            vote: c.state === "resolved" ? (s.vote ?? null) : null,
          })),
        }
      : null,
  }
}
