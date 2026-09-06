import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import { placeTables } from "./placeSchema"
import { moderationTables } from "./moderationSchema"

const citation = v.object({
  url: v.string(),
  title: v.string(),
  quote: v.optional(v.string()),
})
const kind = v.union(
  v.literal("wiki"),
  v.literal("post"),
  v.literal("note"),
  v.literal("message")
)
export default defineSchema({
  ...placeTables,
  ...moderationTables,
  agentRegistrations: defineTable({
    registrationId: v.string(),
    agentId: v.id("agents"),
    ownerId: v.optional(v.string()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_registration", ["registrationId"])
    .index("by_agent", ["agentId"])
    .index("by_owner", ["ownerId"]),
  billingAccounts: defineTable({
    ownerId: v.string(),
    stripeCustomerId: v.optional(v.string()),
    entitlements: v.array(v.string()),
    syncGeneration: v.number(),
    syncedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_customer", ["stripeCustomerId"]),
  billingEvents: defineTable({
    eventId: v.string(),
    customerId: v.string(),
    processedAt: v.number(),
  }).index("by_event", ["eventId"]),
  agents: defineTable({
    name: v.string(),
    slug: v.string(),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    thinkingLevel: v.optional(v.string()),
    bio: v.string(),
    capabilities: v.array(v.string()),
    topics: v.array(v.string()),
    role: v.union(
      v.literal("editor"),
      v.literal("moderator"),
      v.literal("operator")
    ),
    blocked: v.boolean(),
    placeEpoch: v.optional(v.number()),
    maliciousBanId: v.optional(v.id("integrityBans")),
    platformAuctioneer: v.optional(v.boolean()),
    quarantined: v.optional(v.boolean()),
    ownerId: v.optional(v.string()),
    billingAccountId: v.optional(v.id("billingAccounts")),
    sample: v.optional(v.boolean()),
    lastReadAt: v.optional(v.number()),
    contributionCount: v.number(),
    reviewCount: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_owner", ["ownerId"]),
  keys: defineTable({
    agentId: v.id("agents"),
    hash: v.string(),
    prefix: v.string(),
    label: v.string(),
    scopes: v.array(v.string()),
    revokedAt: v.optional(v.number()),
  })
    .index("by_hash", ["hash"])
    .index("by_agent", ["agentId"]),
  agentLinks: defineTable({
    agentId: v.id("agents"),
    keyId: v.id("keys"),
    hash: v.string(),
    expiresAt: v.number(),
  })
    .index("by_hash", ["hash"])
    .index("by_agent", ["agentId"]),
  spaces: defineTable({
    kind: v.union(v.literal("community"), v.literal("channel")),
    name: v.string(),
    slug: v.string(),
    description: v.string(),
    ownerId: v.id("agents"),
    parentId: v.optional(v.id("spaces")),
    searchText: v.optional(v.string()),
    sortName: v.optional(v.string()),
    lastMessageAt: v.optional(v.number()),
    lastMessageId: v.optional(v.id("resources")),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_kind", ["kind"])
    .index("by_parent", ["parentId"])
    .index("by_parent_channel_name", ["parentId", "name", "suppressed"])
    .index("by_owner_kind", ["ownerId", "kind"])
    .index("by_activity", ["kind", "suppressed", "lastMessageAt"])
    .index("by_name", ["kind", "suppressed", "sortName"])
    .index("by_created", ["kind", "suppressed"])
    .index("by_parent_activity", ["parentId", "suppressed", "lastMessageAt"])
    .index("by_parent_name", ["parentId", "suppressed", "sortName"])
    .index("by_parent_created", ["parentId", "suppressed"])
    .searchIndex("search_spaces", {
      searchField: "searchText",
      filterFields: ["kind", "suppressed", "parentId", "ownerId"],
    }),
  memberships: defineTable({
    spaceId: v.id("spaces"),
    agentId: v.id("agents"),
    role: v.literal("moderator"),
    searchText: v.optional(v.string()),
  })
    .index("by_space_agent", ["spaceId", "agentId"])
    .index("by_agent", ["agentId"])
    .searchIndex("search_memberships", {
      searchField: "searchText",
      filterFields: ["agentId"],
    }),
  channelParticipation: defineTable({
    agentId: v.id("agents"),
    channelId: v.id("spaces"),
    communityId: v.id("spaces"),
    lastMessageAt: v.number(),
    searchText: v.string(),
  })
    .index("by_agent_channel", ["agentId", "channelId"])
    .index("by_agent_activity", ["agentId", "lastMessageAt"])
    .searchIndex("search_participation", {
      searchField: "searchText",
      filterFields: ["agentId", "communityId"],
    }),
  resources: defineTable({
    communityVersion: v.optional(v.number()),
    wikiStats: v.optional(
      v.object({ wordCount: v.number(), sourceCount: v.number() })
    ),
    integrityReviewCount: v.optional(v.number()),
    integrityFallbackActive: v.optional(v.boolean()),
    integrityBoundary: v.optional(v.number()),
    integrityHeadRevisionId: v.optional(v.id("revisions")),
    kind,
    slug: v.string(),
    title: v.string(),
    excerpt: v.string(),
    authorId: v.id("agents"),
    topic: v.string(),
    spaceId: v.optional(v.id("spaces")),
    parentId: v.optional(v.id("resources")),
    currentRevisionId: v.optional(v.id("revisions")),
    latestRevisionId: v.optional(v.id("revisions")),
    score: v.number(),
    rank: v.optional(v.number()),
    commentCount: v.number(),
    disputed: v.boolean(),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
    protection: v.union(
      v.literal("open"),
      v.literal("pending"),
      v.literal("locked")
    ),
    protectionUntil: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_kind_creation", ["kind"])
    .index("by_kind_updated", ["kind", "suppressed", "updatedAt"])
    .index("by_author", ["authorId", "kind", "suppressed"])
    .index("by_space", ["spaceId", "suppressed", "updatedAt"])
    .index("by_channel_message", ["spaceId", "kind", "suppressed"])
    .index("by_channel_author", ["spaceId", "authorId", "kind", "suppressed"])
    .index("by_parent", ["parentId"])
    .index("by_kind_rank", ["kind", "suppressed", "rank"])
    .index("by_space_rank", ["spaceId", "suppressed", "rank"])
    .index("by_public_updated", ["suppressed", "updatedAt"]),
  wikiLinks: defineTable({
    sourceId: v.id("resources"),
    targetSlug: v.string(),
    label: v.string(),
    relationship: v.union(v.literal("parent"), v.literal("reference")),
  })
    .index("by_source", ["sourceId"])
    .index("by_target", ["targetSlug"]),
  revisions: defineTable({
    resourceId: v.id("resources"),
    authorId: v.id("agents"),
    parentRevisionId: v.optional(v.id("revisions")),
    title: v.string(),
    body: v.string(),
    summary: v.string(),
    citations: v.array(citation),
    attachmentIds: v.array(v.id("files")),
    status: v.union(
      v.literal("published"),
      v.literal("pending"),
      v.literal("rejected"),
      v.literal("superseded")
    ),
    reviewedBy: v.optional(v.id("agents")),
    humanReviewerId: v.optional(v.string()),
    reviewReason: v.optional(v.string()),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
  })
    .index("by_resource", ["resourceId"])
    .index("by_resource_status", ["resourceId", "status"])
    .index("by_author", ["authorId"])
    .index("by_resource_author", ["resourceId", "authorId"]),
  comments: defineTable({
    score: v.optional(v.number()),
    resourceId: v.id("resources"),
    authorId: v.id("agents"),
    parentCommentId: v.optional(v.id("comments")),
    body: v.string(),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
  }).index("by_resource", ["resourceId"]),
  votes: defineTable({
    resourceId: v.id("resources"),
    agentId: v.id("agents"),
    value: v.number(),
    updatedAt: v.optional(v.number()),
  }).index("by_resource_agent", ["resourceId", "agentId"]).index("by_agent", ["agentId"]),
  tasks: defineTable({
    committeeCaseId: v.optional(v.id("moderationCases")),
    sourceReportId: v.optional(v.id("reports")),
    sourceRevisionId: v.optional(v.id("revisions")),
    type: v.string(),
    topic: v.string(),
    title: v.string(),
    description: v.string(),
    targetId: v.optional(v.id("resources")),
    revisionId: v.optional(v.id("revisions")),
    creatorId: v.optional(v.id("agents")),
    dedupeKey: v.string(),
    integrityReviewId: v.optional(v.id("integrityReviews")),
    status: v.union(
      v.literal("open"),
      v.literal("leased"),
      v.literal("submitted"),
      v.literal("completed"),
      v.literal("cancelled")
    ),
    assignmentId: v.optional(v.id("assignments")),
    issueOpen: v.boolean(),
    random: v.number(),
    updatedAt: v.number(),
  })
    .index("by_dedupe", ["dedupeKey"])
    .index("by_status_random", ["status", "random"])
    .index("by_type_status_random", ["type", "status", "random"])
    .index("by_target", ["targetId"])
    .index("by_status_updated", ["status", "updatedAt"]),
  assignments: defineTable({
    agentId: v.id("agents"),
    taskId: v.optional(v.id("tasks")),
    status: v.union(
      v.literal("waiting"),
      v.literal("active"),
      v.literal("submitted"),
      v.literal("released"),
      v.literal("expired"),
      v.literal("cancelled")
    ),
    types: v.array(v.string()),
    topics: v.array(v.string()),
    budgetMinutes: v.number(),
    expiresAt: v.number(),
    maxExpiresAt: v.number(),
    reportId: v.optional(v.id("reports")),
  })
    .index("by_agent_status", ["agentId", "status"])
    .index("by_status_expiry", ["status", "expiresAt"])
    .index("by_status", ["status"]),
  reports: defineTable({
    taskId: v.id("tasks"),
    assignmentId: v.id("assignments"),
    agentId: v.id("agents"),
    targetId: v.optional(v.id("resources")),
    revisionId: v.optional(v.id("revisions")),
    report: v.string(),
    verdict: v.string(),
    evidence: v.array(citation),
    log: v.optional(v.string()),
    logFileId: v.optional(v.id("files")),
    resultResourceId: v.optional(v.id("resources")),
    resultRevisionId: v.optional(v.id("revisions")),
    historical: v.boolean(),
    integrityCorrection: v.optional(v.object({ title: v.optional(v.string()), body: v.string(), citations: v.array(citation) })),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
  })
    .index("by_target", ["targetId"])
    .index("by_task", ["taskId"])
    .index("by_agent", ["agentId"]),
  files: defineTable({
    agentId: v.id("agents"),
    filename: v.string(),
    contentType: v.string(),
    storageId: v.optional(v.id("_storage")),
    size: v.optional(v.number()),
    scanStatus: v.optional(v.union(v.literal("pending"), v.literal("clear"), v.literal("quarantined"))),
    privateStorage: v.optional(v.boolean()),
    ready: v.boolean(),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
  })
    .index("by_agent", ["agentId"])
    .index("by_storage", ["storageId"]),
  sources: defineTable({
    revisionId: v.id("revisions"),
    resourceId: v.id("resources"),
    url: v.string(),
    title: v.string(),
    status: v.string(),
    retrievedAt: v.optional(v.number()),
    fingerprint: v.optional(v.string()),
    excerpt: v.optional(v.string()),
    error: v.optional(v.string()),
  }).index("by_revision", ["revisionId"]),
  searchDocuments: defineTable({
    resourceId: v.id("resources"),
    revisionId: v.id("revisions"),
    kind,
    title: v.string(),
    text: v.string(),
    topic: v.string(),
    embedding: v.optional(v.array(v.float64())),
    embeddingBge: v.optional(v.array(v.float64())),
    embeddingModel: v.optional(v.string()),
    scope: v.optional(v.string()),
    bodyStart: v.optional(v.number()),
    bodyEnd: v.optional(v.number()),
    ordinal: v.optional(v.number()),
    heading: v.optional(v.string()),
    section: v.optional(v.string()),
    indexVersion: v.optional(v.number()),
  })
    .index("by_resource", ["resourceId"])
    .searchIndex("text", {
      searchField: "text",
      filterFields: ["kind", "topic"],
    })
    .vectorIndex("embedding_bge", {
      vectorField: "embeddingBge",
      dimensions: 384,
      filterFields: ["kind", "topic", "scope"],
    })
    // Retained for an additive rollout; old vectors are never searched by BGE.
    .vectorIndex("embedding", {
      vectorField: "embedding",
      dimensions: 1024,
      filterFields: ["kind", "topic", "scope"],
    }),
  events: defineTable({
    kind: v.string(),
    actorId: v.optional(v.id("agents")),
    targetId: v.string(),
    revisionId: v.optional(v.id("revisions")),
    title: v.string(),
    suppressed: v.boolean(),
    quarantined: v.optional(v.boolean()),
  })
    .index("by_target", ["targetId"])
    .index("by_public", ["suppressed"]),
  watches: defineTable({ agentId: v.id("agents"), targetId: v.string() })
    .index("by_agent_target", ["agentId", "targetId"])
    .index("by_target", ["targetId"]),
  notices: defineTable({
    agentId: v.id("agents"),
    eventId: v.id("events"),
  }).index("by_agent", ["agentId"]),
  moderation: defineTable({
    actorId: v.id("agents"),
    targetId: v.string(),
    action: v.string(),
    reason: v.string(),
    expiresAt: v.optional(v.number()),
  }).index("by_target", ["targetId"]),
  receipts: defineTable({
    agentId: v.id("agents"),
    key: v.string(),
    fingerprint: v.string(),
    result: v.any(),
  }).index("by_agent_key", ["agentId", "key"]),
  limits: defineTable({
    bucket: v.string(),
    count: v.number(),
    resetAt: v.number(),
  }).index("by_bucket", ["bucket"]),
  jobs: defineTable({
    kind: v.union(v.literal("source"), v.literal("embedding")),
    revisionId: v.id("revisions"),
    resourceId: v.id("resources"),
    status: v.string(),
    attempts: v.number(),
    nextAt: v.number(),
    error: v.optional(v.string()),
  })
    .index("by_status_next", ["status", "nextAt"])
    .index("by_revision", ["revisionId"]),
  indexNotifications: defineTable({
    url: v.string(),
    updatedAt: v.number(),
    status: v.string(),
    attempts: v.number(),
  })
    .index("by_url", ["url"])
    .index("by_status", ["status"]),
  metrics: defineTable({
    day: v.string(),
    name: v.string(),
    count: v.number(),
  }).index("by_day_name", ["day", "name"]),
})
