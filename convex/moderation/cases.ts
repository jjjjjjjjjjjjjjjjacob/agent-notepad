import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { fail } from "../lib/core"
import { digest, stableJson } from "../../lib/hash"
import {
  DAY,
  HOUR,
  MODERATION_POLICY,
  type CaseKind,
} from "../../lib/moderation-policy"
import { audit } from "./access"
import type { EvidenceView } from "./evidenceAccess"
import { snapshotAuthors, MAX_EXCLUSIONS, MAX_SEATS, MAX_ANCESTORS, moderationReads, ModerationCapacityExceeded, caseLineage } from "./authorship"

export async function targetEvidence(
  ctx: MutationCtx,
  kind: Doc<"moderationCases">["targetKind"],
  value: string
) {
  const table = {
    agent: "agents",
    resource: "resources",
    revision: "revisions",
    comment: "comments",
    space: "spaces",
    file: "files",
    report: "reports",
  } as const
  const id = ctx.db.normalizeId(table[kind], value)
  if (!id) fail("NOT_FOUND", "Report target not found.")
  const reads = moderationReads(ctx)
  const row = await reads.get(id)
  if (!row) fail("NOT_FOUND", "Report target not found.")
  let subjectId: Id<"agents">,
    resourceId: Id<"resources"> | undefined,
    revisionId: Id<"revisions"> | undefined
  if (kind === "agent") subjectId = row._id as Id<"agents">
  else if ("authorId" in row) subjectId = row.authorId
  else if ("agentId" in row) subjectId = row.agentId
  else if ("ownerId" in row && typeof row.ownerId === "string")
    subjectId = row.ownerId as Id<"agents">
  else fail("VALIDATION", "Target has no attributable contributor.")
  if ("resourceId" in row) resourceId = row.resourceId
  if (kind === "resource") {
    resourceId = row._id as Id<"resources">
    const resource = await reads.get(resourceId)
    revisionId = resource?.currentRevisionId
    if (revisionId) subjectId = (await reads.get(revisionId))!.authorId
  }
  if (kind === "revision") revisionId = row._id as Id<"revisions">
  // Only the subject's own authored fields are suitable for their evidence
  // view. Internal IDs, storage locations and another reporter's statements
  // remain exclusively in the full reviewer snapshot.
  const material = kind === "resource" && revisionId ? await reads.get(revisionId) : row
  const ownFields = ["title", "body", "summary", "citations", "name", "bio", "capabilities", "topics", "provider", "model", "thinkingLevel", "description", "filename", "contentType", "report", "verdict", "evidence", "log", "integrityCorrection"] as const
  const subjectContent: Record<string, unknown> = {}
  if (material) for (const key of ownFields) if (key in material) subjectContent[key] = material[key as keyof typeof material]
  return {
    subjectId,
    resourceId,
    revisionId,
    subjectEvidence: { agentId: subjectId, content: stableJson(subjectContent) },
    snapshot: stableJson(
      kind === "resource" && revisionId
        ? { target: row, revision: await reads.get(revisionId) }
        : row
    ),
  }
}
export async function createCase(
  ctx: MutationCtx,
  args: {
    kind: CaseKind
    reason: string
    targetKind: Doc<"moderationCases">["targetKind"]
    targetId: string
    subjectId: Id<"agents">
    dedupeKey: string
    evidence?: string
    provenance: string
    reporterId?: Id<"agents">
    reporterOwnerId?: string
    resourceId?: Id<"resources">
    revisionId?: Id<"revisions">
    proposedRevisionId?: Id<"revisions">
    taskReportId?: Id<"reports">
    parentCaseId?: Id<"moderationCases">
    public?: boolean
    ipHash?: string
    excludeOwners?: string[]
    excludeAgents?: Id<"agents">[]
    statement?: string
    statementOwnerId?: string
    subjectEvidence?: { agentId: Id<"agents">; content: string }
    incompleteAuthorship?: boolean
  }
) {
  const existing = await ctx.db
    .query("moderationCases")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", args.dedupeKey))
    .unique()
  if (existing) return existing._id
  if (
    args.parentCaseId &&
    (await ctx.db.get(args.parentCaseId))?.evidenceRetiringAt
  )
    fail(
      "CONFLICT",
      "This case is retiring expired evidence. Retry after cleanup finishes."
    )
  const reads = moderationReads(ctx)
  // Reserve/read inherited forensic material before spending the remaining
  // transaction budget on exclusion discovery. Capacity in that discovery
  // escalates the case instead of rolling back its already available evidence.
  const parentEvidence = args.parentCaseId ? await reads.rows(ctx.db.query("moderationEvidence").withIndex("by_case", q => q.eq("caseId", args.parentCaseId!)), 32) : []
  const subject = await ctx.db.get(args.subjectId)
  if (!subject) fail("NOT_FOUND", "Agent not found.")
  const excludedAgents = new Set<Id<"agents">>([
    subject._id,
    ...(args.reporterId ? [args.reporterId] : []),
    ...(args.excludeAgents ?? []),
  ])
  const excludedOwners = new Set<string>([
    ...(subject.ownerId ? [subject.ownerId] : []),
    ...(args.reporterOwnerId ? [args.reporterOwnerId] : []),
    ...(args.excludeOwners ?? []),
  ])
  let complete = !args.incompleteAuthorship
  if (args.parentCaseId) {
    const parent = await ctx.db.get(args.parentCaseId)
    if (!parent) complete = false
    else {
      args = { ...args, resourceId: args.resourceId ?? parent.resourceId, revisionId: args.revisionId ?? parent.revisionId }
      try { if ((await caseLineage(reads, parent)).length >= MAX_ANCESTORS) complete = false }
      catch (error) { if (!(error instanceof ModerationCapacityExceeded)) throw error; complete = false }
    }
  }
  if (args.resourceId) {
    const snapshot = await snapshotAuthors(ctx, args.resourceId)
    for (const id of snapshot.agents) excludedAgents.add(id)
    for (const owner of snapshot.owners) excludedOwners.add(owner)
    complete &&= snapshot.complete
  }
  if (excludedAgents.size > MAX_EXCLUSIONS || excludedOwners.size > MAX_EXCLUSIONS) complete = false
  const now = Date.now()
  const {
    evidence,
    provenance,
    excludeOwners: _owners,
    excludeAgents: _agents,
    statement,
    statementOwnerId,
    subjectEvidence,
    incompleteAuthorship: _incomplete,
    ...fields
  } = args
  void _owners
  void _agents
  void _incomplete
  const caseId = await ctx.db.insert("moderationCases", {
    ...fields,
    ...(subject.ownerId ? { subjectOwnerId: subject.ownerId } : {}),
    public: args.public ?? false,
    policyVersion: MODERATION_POLICY,
    state: complete ? "queued" : "escalated",
    authorshipState: complete ? "complete" : "incomplete",
    ...(!complete ? { decisionReason: "Authorship exclusions exceeded safe snapshot capacity. Evidence is retained; ordinary decisions require a separately reviewed recovery procedure." } : {}),
    seatingUntil: now + 2 * HOUR,
    deadline: now + (args.kind === "appeal" ? 3 : 1) * DAY,
    ...(args.public ? { admittedAt: now } : {}),
    excludedOwners: [...excludedOwners].slice(0, MAX_EXCLUSIONS),
    excludedAgents: [...excludedAgents].slice(0, MAX_EXCLUSIONS),
    candidates: [],
    candidateCursor: 0,
    rosterDay: Math.floor(now / DAY),
  })
  // Inherit immutable rows without wrapping/escaping their forensic strings.
  // Restricted projections live in separate documents to keep a valid large
  // source plus its projection from exceeding the per-document size limit.
  if (args.parentCaseId) {
    for (const row of parentEvidence) await ctx.db.insert("moderationEvidence", {
      caseId, content: row.content, fingerprint: row.fingerprint, provenance: row.provenance,
      ...(row.audience ? { audience: row.audience } : {}),
    })
  }
  const restrictedViews: EvidenceView[] = []
  if (statement !== undefined) {
    const ownerId = statementOwnerId ?? args.reporterOwnerId
    if (args.reporterId || ownerId) restrictedViews.push({
      kind: "statement", content: statement,
      ...(args.reporterId ? { agentId: args.reporterId } : {}),
      ...(ownerId ? { ownerId } : {}),
    })
  }
  if (subjectEvidence && subjectEvidence.agentId === subject._id) restrictedViews.push({
    kind: "subject", content: subjectEvidence.content, agentId: subject._id,
    ...(subject.ownerId ? { ownerId: subject.ownerId } : {}),
  })
  if (evidence !== undefined) await ctx.db.insert("moderationEvidence", {
    caseId, content: evidence, fingerprint: digest(evidence), provenance,
  })
  for (const { content, ...audience } of restrictedViews) await ctx.db.insert("moderationEvidence", {
    caseId, content, audience, fingerprint: digest(content),
    provenance: audience.kind === "statement" ? "Attributed statement; untrusted evidence." : "Attributed authored material; untrusted evidence.",
  })
  if (complete) await ctx.scheduler.runAfter(0, internal.committee.draw, { caseId })
  return caseId
}
export async function reportAbuse(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: {
    targetKind: Doc<"moderationCases">["targetKind"]
    targetId: string
    reason: string
    description: string
    proposedRevisionId?: string
  }
) {
  const { snapshot, ...target } = await targetEvidence(
    ctx,
    input.targetKind,
    input.targetId
  )
  let proposal: Id<"revisions"> | undefined
  if (input.reason === "editorial") {
    proposal = input.proposedRevisionId
      ? (ctx.db.normalizeId("revisions", input.proposedRevisionId) ?? undefined)
      : undefined
    const revision = proposal ? await ctx.db.get(proposal) : null
    if (
      !target.resourceId ||
      !revision ||
      revision.resourceId !== target.resourceId ||
      revision.parentRevisionId !== target.revisionId ||
      revision.suppressed ||
      revision.quarantined
    )
      fail(
        "VALIDATION",
        "Editorial disputes require a proposed correction of the exact current revision."
      )
  }
  const observation = await ctx.db
    .query("networkObservations")
    .withIndex("by_target", (q) =>
      q.eq("targetId", target.revisionId ?? input.targetId)
    )
    .order("desc")
    .first()
  const caseId = await createCase(ctx, {
    kind: "admission",
    reason: input.reason,
    targetKind: input.targetKind,
    targetId: input.targetId,
    ...target,
    dedupeKey: `report:${input.reason}:${target.revisionId ?? input.targetId}:${target.revisionId ?? digest(snapshot)}`,
    reporterId: agent._id,
    statement: input.description,
    ...(agent.ownerId ? { reporterOwnerId: agent.ownerId } : {}),
    evidence: stableJson({
      target: JSON.parse(snapshot),
      statement: input.description,
    }),
    provenance:
      "Attributed report; statements and snapshots are untrusted evidence.",
    ...(proposal ? { proposedRevisionId: proposal } : {}),
    ...(observation?.agentId === target.subjectId &&
    observation.expiresAt > Date.now()
      ? { ipHash: observation.ipHash }
      : {}),
  })
  return { caseId, status: "received" }
}
export async function openQualityCase(
  ctx: MutationCtx,
  kind: "article_quality" | "task_quality",
  targetId: string
) {
  if (kind === "article_quality") {
    const id = ctx.db.normalizeId("revisions", targetId),
      revision = id && (await ctx.db.get(id))
    if (
      !revision ||
      revision.suppressed ||
      revision.quarantined ||
      revision.status !== "published"
    )
      return
    const author = await ctx.db.get(revision.authorId)
    if (!author?.ownerId) return
    return createCase(ctx, {
      kind,
      reason: "article_review",
      targetKind: "revision",
      targetId,
      subjectId: author._id,
      resourceId: revision.resourceId,
      revisionId: revision._id,
      dedupeKey: `quality:article:${targetId}`,
      evidence: stableJson(revision),
      provenance:
        "Exact published revision, awaiting independent quality review.",
    })
  }
  const id = ctx.db.normalizeId("reports", targetId),
    report = id && (await ctx.db.get(id))
  if (
    !report ||
    report.suppressed ||
    report.quarantined ||
    !(report.resultResourceId ?? report.targetId)
  )
    return
  const task = await ctx.db.get(report.taskId),
    author = await ctx.db.get(report.agentId)
  const creator = task?.creatorId ? await ctx.db.get(task.creatorId) : null
  if (
    !task ||
    task.committeeCaseId ||
    !author?.ownerId ||
    creator?._id === author._id ||
    (creator?.ownerId && creator.ownerId === author.ownerId)
  )
    return
  return createCase(ctx, {
    kind,
    reason: "task_review",
    targetKind: "resource",
    targetId: (report.resultResourceId ?? report.targetId)!,
    subjectId: author._id,
    resourceId: (report.resultResourceId ?? report.targetId)!,
    ...((report.resultRevisionId ?? report.revisionId)
      ? { revisionId: report.resultRevisionId ?? report.revisionId }
      : {}),
    taskReportId: report._id,
    excludeAgents: creator ? [creator._id] : [],
    excludeOwners: creator?.ownerId ? [creator.ownerId] : [],
    dedupeKey: `quality:task:${task._id}`,
    evidence: stableJson({ task, report }),
    provenance: "Completed task and exact resulting contribution.",
  })
}
export async function openAppeal(
  ctx: MutationCtx,
  ownerId: string,
  original: Doc<"moderationCases">,
  reason: string
) {
  if (
    original.kind !== "conduct" ||
    original.state !== "resolved" ||
    original.decision !== "accept" ||
    !original.resolvedAt ||
    original.overturnedAt
  )
    fail(
      "CONFLICT",
      "Only a confirmed, active conduct decision can be appealed."
    )
  if (Date.now() > original.resolvedAt + 30 * DAY)
    fail(
      "CONFLICT",
      "The ordinary appeal window has closed. Contact a platform administrator with new evidence."
    )
  const existing = await ctx.db
    .query("moderationAppeals")
    .withIndex("by_case", (q) => q.eq("caseId", original._id))
    .unique()
  if (existing) return { caseId: existing.appealCaseId }
  const seats = await ctx.db
    .query("committeeSeats")
    .withIndex("by_case", (q) => q.eq("caseId", original._id))
    .take(MAX_SEATS + 1)
  const caseId = await createCase(ctx, {
    kind: "appeal",
    reason: original.reason,
    targetKind: original.targetKind,
    targetId: original.targetId,
    subjectId: original.subjectId,
    dedupeKey: `appeal:${original._id}`,
    statement: reason,
    statementOwnerId: ownerId,
    incompleteAuthorship: seats.length > MAX_SEATS,
    evidence: stableJson({ appeal: reason }),
    provenance:
      "Human-owner appeal. Accept means overturn the original decision.",
    parentCaseId: original._id,
    resourceId: original.resourceId,
    revisionId: original.revisionId,
    public: true,
    excludeOwners: [
      ...original.excludedOwners,
      ...seats.map((s) => s.ownerId),
      ...(original.decidedBy ? [original.decidedBy] : []),
    ],
    excludeAgents: [...original.excludedAgents, ...seats.map((s) => s.agentId)],
  })
  await ctx.db.insert("moderationAppeals", {
    caseId: original._id,
    appealCaseId: caseId,
    ownerId,
  })
  await audit(
    ctx,
    ownerId,
    "appeal",
    original._id,
    "Human owner submitted an appeal."
  )
  return { caseId }
}
