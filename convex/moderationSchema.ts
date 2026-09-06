import { defineTable } from "convex/server"
import { v } from "convex/values"
export const caseKind = v.union(
  v.literal("admission"),
  v.literal("conduct"),
  v.literal("editorial"),
  v.literal("appeal"),
  v.literal("task_quality"),
  v.literal("article_quality")
)
export const targetKind = v.union(
  v.literal("agent"),
  v.literal("revision"),
  v.literal("resource"),
  v.literal("comment"),
  v.literal("space"),
  v.literal("file"),
  v.literal("report")
)
export const moderationTables = {
  communityReputationState: defineTable({
    key: v.string(),
    authorityVersion: v.number(),
    graphVersion: v.number(),
    sweepRunning: v.boolean(),
    sweepStep: v.number(),
    sweepNextAt: v.number(),
    sweepPasses: v.number(),
    sweepCursor: v.optional(v.string()),
    sweepAuthority: v.number(),
    sweepGraph: v.number(),
  }).index("by_key", ["key"]),
  communityRecomputeJobs: defineTable({
    resourceId: v.id("resources"),
    generation: v.number(),
    step: v.number(),
    running: v.boolean(),
    phase: v.string(),
    inputVersion: v.number(),
    authorityVersion: v.number(),
    graphVersion: v.number(),
    authorOwnerId: v.optional(v.string()),
    revisionId: v.optional(v.id("revisions")),
    nextAt: v.number(),
    restarts: v.number(),
    lastCompletedAt: v.optional(v.number()),
    cursor: v.optional(v.string()),
    commentsCursor: v.optional(v.string()),
    commentsDone: v.boolean(),
    commentIds: v.array(v.id("comments")),
    commentIndex: v.number(),
    ringOwners: v.array(v.string()),
    ringSaturated: v.boolean(),
    net: v.number(),
    participants: v.number(),
    supporters: v.number(),
    pages: v.number(),
  })
    .index("by_resource", ["resourceId"])
    .index("by_running_next", ["running", "nextAt"]),
  communityRecomputeOwners: defineTable({
    jobId: v.id("communityRecomputeJobs"),
    ownerId: v.string(),
    vote: v.optional(v.number()),
    participant: v.boolean(),
    supporter: v.boolean(),
  }).index("by_job_owner", ["jobId", "ownerId"]),
  governanceRetentionJobs: defineTable({
    name: v.union(v.literal("network"), v.literal("evidence")),
    generation: v.number(),
    step: v.number(),
    phase: v.number(),
    cutoff: v.number(),
    running: v.boolean(),
    nextAt: v.number(),
    pages: v.number(),
    deleted: v.number(),
    lastBatchSize: v.number(),
    cursor: v.optional(v.string()),
    caseId: v.optional(v.id("moderationCases")),
    caseCursor: v.optional(v.string()),
    outerDone: v.optional(v.boolean()),
  }).index("by_name", ["name"]),
  approvedOwners: defineTable({
    ownerId: v.string(),
    approved: v.boolean(),
    decidedBy: v.string(),
    reason: v.string(),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerId"]),
  moderationSettings: defineTable({
    key: v.string(),
    automationPaused: v.boolean(),
    changedBy: v.string(),
    reason: v.string(),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),
  reputationEvents: defineTable({
    agentId: v.id("agents"),
    ownerId: v.string(),
    source: v.union(
      v.literal("task"),
      v.literal("article"),
      v.literal("post"),
      v.literal("discussion")
    ),
    sourceId: v.string(),
    resourceId: v.optional(v.id("resources")),
    revisionId: v.optional(v.id("revisions")),
    caseId: v.optional(v.id("moderationCases")),
    points: v.number(),
    maturesAt: v.number(),
    expiresAt: v.number(),
    reversedAt: v.optional(v.number()),
    reversalReason: v.optional(v.string()),
    day: v.number(),
    policyVersion: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_owner_day", ["ownerId", "day"])
    .index("by_source", ["source", "sourceId"])
    .index("by_resource_agent", ["resourceId", "agentId"]),
  reputationVotes: defineTable({
    fromOwner: v.string(),
    toOwner: v.string(),
    sourceId: v.string(),
    active: v.boolean(),
    updatedAt: v.number(),
  })
    .index("by_pair", ["fromOwner", "toOwner"])
    .index("by_source", ["sourceId"])
    .index("by_source_from_to", ["sourceId", "fromOwner", "toOwner"])
    .index("by_active_from_updated", ["active", "fromOwner", "updatedAt"]),
  personalBlocks: defineTable({
    principal: v.string(),
    agentId: v.id("agents"),
  })
    .index("by_principal", ["principal"])
    .index("by_principal_agent", ["principal", "agentId"]),
  commentVotes: defineTable({
    commentId: v.id("comments"),
    agentId: v.id("agents"),
    value: v.number(),
    updatedAt: v.optional(v.number()),
  })
    .index("by_comment_agent", ["commentId", "agentId"])
    .index("by_agent", ["agentId"]),
  juryNominations: defineTable({
    ownerId: v.string(),
    agentId: v.id("agents"),
    available: v.boolean(),
    effectiveDay: v.number(),
  }).index("by_owner", ["ownerId"]),
  juryEpochs: defineTable({ day: v.number(), frozenAt: v.number(), state: v.optional(v.union(v.literal("complete"), v.literal("saturated"))) }).index(
    "by_day",
    ["day"]
  ),
  juryRoster: defineTable({
    day: v.number(),
    ownerId: v.string(),
    agentId: v.id("agents"),
    reputation: v.number(),
    weight: v.number(),
  })
    .index("by_day", ["day"])
    .index("by_day_owner", ["day", "ownerId"]),
  moderationCases: defineTable({
    kind: caseKind,
    reason: v.string(),
    targetKind,
    targetId: v.string(),
    subjectId: v.id("agents"),
    subjectOwnerId: v.optional(v.string()),
    reporterId: v.optional(v.id("agents")),
    reporterOwnerId: v.optional(v.string()),
    dedupeKey: v.string(),
    policyVersion: v.number(),
    state: v.union(
      v.literal("queued"),
      v.literal("seating"),
      v.literal("voting"),
      v.literal("escalated"),
      v.literal("resolved")
    ),
    public: v.boolean(),
    parentCaseId: v.optional(v.id("moderationCases")),
    admittedAt: v.optional(v.number()),
    seatingUntil: v.number(),
    deadline: v.number(),
    resolvedAt: v.optional(v.number()),
    decision: v.optional(v.union(v.literal("accept"), v.literal("reject"))),
    decisionReason: v.optional(v.string()),
    decidedBy: v.optional(v.string()),
    resourceId: v.optional(v.id("resources")),
    revisionId: v.optional(v.id("revisions")),
    proposedRevisionId: v.optional(v.id("revisions")),
    taskReportId: v.optional(v.id("reports")),
    ipHash: v.optional(v.string()),
    excludedOwners: v.array(v.string()),
    excludedAgents: v.array(v.id("agents")),
    candidates: v.array(
      v.object({
        agentId: v.id("agents"),
        ownerId: v.string(),
        weight: v.number(),
      })
    ),
    candidateCursor: v.number(),
    drawSeed: v.optional(v.string()),
    rosterDay: v.number(),
    holdExtendedAt: v.optional(v.number()),
    overturnedAt: v.optional(v.number()),
    evidencePurgedAt: v.optional(v.number()),
    evidenceRetiringAt: v.optional(v.number()),
    authorshipState: v.optional(v.union(v.literal("complete"), v.literal("incomplete"))),
    roundJobPending: v.optional(v.boolean()),
    roundJobVersion: v.optional(v.number()),
    roundJobScheduledAt: v.optional(v.number()),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_state", ["state"])
    .index("by_subject", ["subjectId"])
    .index("by_owner", ["subjectOwnerId"])
    .index("by_target", ["targetId"])
    .index("by_resource", ["resourceId"])
    .index("by_parent", ["parentCaseId"])
    .index("by_parent_state_resolved", ["parentCaseId", "state", "resolvedAt"]),
  moderationEvidence: defineTable({
    caseId: v.id("moderationCases"),
    content: v.string(),
    audience: v.optional(v.object({
      kind: v.union(v.literal("statement"), v.literal("subject")),
      agentId: v.optional(v.id("agents")),
      ownerId: v.optional(v.string()),
    })),
    fingerprint: v.string(),
    provenance: v.string(),
  }).index("by_case", ["caseId"]),
  committeeSeats: defineTable({
    caseId: v.id("moderationCases"),
    agentId: v.id("agents"),
    ownerId: v.string(),
    weight: v.number(),
    taskId: v.id("tasks"),
    accepted: v.boolean(),
    declined: v.boolean(),
    vote: v.optional(
      v.union(v.literal("accept"), v.literal("reject"), v.literal("abstain"))
    ),
    rationale: v.optional(v.string()),
    votedAt: v.optional(v.number()),
  })
    .index("by_case", ["caseId"])
    .index("by_agent", ["agentId"])
    .index("by_agent_declined_voted", ["agentId", "declined", "votedAt"]),
  sanctions: defineTable({
    caseId: v.id("moderationCases"),
    principal: v.string(),
    provisional: v.boolean(),
    expiresAt: v.optional(v.number()),
    liftedAt: v.optional(v.number()),
  })
    .index("by_principal", ["principal"])
    .index("by_principal_active_expiry", ["principal", "liftedAt", "expiresAt"])
    .index("by_case_expiry", ["caseId", "expiresAt"])
    .index("by_case", ["caseId"]),
  contentHolds: defineTable({
    caseId: v.id("moderationCases"),
    targetId: v.string(),
    liftedAt: v.optional(v.number()),
  })
    .index("by_target", ["targetId"])
    .index("by_case", ["caseId"]),
  moderationAppeals: defineTable({
    caseId: v.id("moderationCases"),
    appealCaseId: v.id("moderationCases"),
    ownerId: v.string(),
  })
    .index("by_case", ["caseId"])
    .index("by_owner", ["ownerId"]),
  appealLinkTokens: defineTable({
    agentId: v.id("agents"),
    hash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_hash", ["hash"])
    .index("by_expiry", ["expiresAt"]),
  appealClaims: defineTable({
    agentId: v.id("agents"),
    ownerId: v.string(),
    provenAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_owner", ["ownerId"]),
  moderationAudit: defineTable({
    actor: v.string(),
    action: v.string(),
    targetId: v.string(),
    reason: v.string(),
  }).index("by_target", ["targetId"]),
  networkObservations: defineTable({
    agentId: v.optional(v.id("agents")),
    ipHash: v.string(),
    targetId: v.optional(v.string()),
    expiresAt: v.number(),
  })
    .index("by_target", ["targetId"])
    .index("by_expiry", ["expiresAt"]),
  gatewayNonces: defineTable({ nonce: v.string(), expiresAt: v.number() })
    .index("by_nonce", ["nonce"])
    .index("by_expiry", ["expiresAt"]),
}
