import { defineTable } from "convex/server"
import { v } from "convex/values"
export const paymentObservation = v.object({
  eventId: v.string(), reference: v.string(), amountCents: v.number(),
  feeCents: v.number(), outcome: v.union(v.literal("succeeded"), v.literal("failed")),
  mode: v.literal("sandbox"),
})
export const seller = v.object({
  agentId: v.id("agents"),
  ownerId: v.string(),
  epoch: v.number(),
  count: v.number(),
  weight: v.number(),
  approved: v.boolean(),
})
export const manifestEntry = v.object({
  pixel: v.number(),
  ownerId: v.optional(v.id("agents")),
  epoch: v.number(),
  version: v.string(),
  banId: v.optional(v.id("integrityBans")),
})
export const placeTables = {
  placeAccounts: defineTable({
    ownerId: v.string(),
    mode: v.literal("sandbox"),
    currency: v.literal("USD"),
    unallocated: v.number(),
    frozen: v.boolean(),
    shortfall: v.number(),
    reconciledAt: v.optional(v.number()),
    capacityVersion: v.optional(v.union(v.literal(0), v.literal(1))),
    pendingCapacityCents: v.optional(v.string()),
    capacityCursor: v.optional(v.string()),
    capacityNextAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerId"])
    .index("by_frozen", ["frozen"])
    .index("by_capacity_next", ["capacityVersion", "capacityNextAt"])
    .index("by_frozen_reconciled", ["frozen", "reconciledAt"]),
  placeAllocations: defineTable({
    agentId: v.id("agents"),
    ownerId: v.string(),
    available: v.number(),
    reserved: v.number(),
    budgetManager: v.boolean(),
  })
    .index("by_agent", ["agentId"])
    .index("by_owner", ["ownerId"]),
  placeLedger: defineTable({
    reference: v.string(),
    kind: v.string(),
    postings: v.array(v.object({ account: v.string(), cents: v.number() })),
    ownerIds: v.array(v.string()),
  }).index("by_reference", ["reference"]),
  placeHumanReceipts: defineTable({
    ownerId: v.string(),
    key: v.string(),
    fingerprint: v.string(),
    result: v.any(),
  }).index("by_owner_key", ["ownerId", "key"]),
  placePayments: defineTable({
    ownerId: v.string(),
    kind: v.union(
      v.literal("deposit"),
      v.literal("withdrawal"),
      v.literal("reversal")
    ),
    amountCents: v.number(),
    feeCents: v.number(),
    status: v.string(),
    reference: v.string(),
    eventId: v.optional(v.string()),
    reversedCents: v.optional(v.number()),
    nextAt: v.number(),
    attempts: v.number(),
    error: v.optional(v.string()),
    capacityCents: v.optional(v.number()),
    reconciliationEvent: v.optional(paymentObservation),
  })
    .index("by_status_next", ["status", "nextAt"])
    .index("by_owner", ["ownerId"])
    .index("by_reference", ["reference"]),
  placeProviderEvents: defineTable({
    provider: v.literal("sandbox"),
    eventId: v.string(),
    fingerprint: v.string(),
    applied: v.optional(v.boolean()),
  }).index("by_provider_event", ["provider", "eventId"]),
  placePixels: defineTable({
    pixel: v.number(),
    ownerId: v.optional(v.id("agents")),
    epoch: v.number(),
    version: v.string(),
    pendingDealId: v.optional(v.id("placeDeals")),
    prospectiveBuyer: v.optional(v.id("agents")),
  })
    .index("by_pixel", ["pixel"])
    .index("by_owner_pixel", ["ownerId", "pixel"])
    .index("by_buyer_pixel", ["prospectiveBuyer", "pixel"]),
  placeTiles: defineTable({
    tile: v.number(),
    colors: v.bytes(),
    updatedAt: v.number(),
  }).index("by_tile", ["tile"]),
  placePaints: defineTable({
    agentId: v.id("agents"),
    pixels: v.array(
      v.object({ pixel: v.number(), before: v.number(), color: v.number() })
    ),
  }).index("by_agent", ["agentId"]),
  placeDeals: defineTable({
    kind: v.union(
      v.literal("initial"),
      v.literal("buy_now"),
      v.literal("auction"),
      v.literal("offer"),
      v.literal("transfer"),
      v.literal("forfeiture")
    ),
    title: v.string(),
    creatorId: v.optional(v.id("agents")),
    creatorOwnerId: v.optional(v.string()),
    status: v.string(),
    pixelCount: v.number(),
    appended: v.number(),
    chunkCount: v.number(),
    lastPixel: v.number(),
    manifestHash: v.string(),
    termsHash: v.optional(v.string()),
    sellers: v.array(seller),
    priceCents: v.number(),
    minimumCents: v.number(),
    feeCents: v.optional(v.number()),
    durationMs: v.number(),
    buyerId: v.optional(v.id("agents")),
    buyerEpoch: v.optional(v.number()),
    buyerOwnerId: v.optional(v.string()),
    reservationId: v.optional(v.id("placeReservations")),
    bidCount: v.number(),
    expiresAt: v.optional(v.number()),
    nextAt: v.number(),
    preparedChunks: v.number(),
    cleanupChunk: v.number(),
    conflictChunk: v.optional(v.number()),
    conflictOffset: v.optional(v.number()),
    conflictCursor: v.optional(v.string()),
    conflictsReady: v.optional(v.boolean()),
    invalidationDone: v.optional(v.boolean()),
    committedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    lotId: v.optional(v.id("placeForfeitures")),
  })
    .index("by_status_next", ["status", "nextAt"])
    .index("by_kind_status", ["kind", "status"])
    .index("by_buyer", ["buyerId"])
    .index("by_creator", ["creatorId"]),
  placeManifests: defineTable({
    dealId: v.id("placeDeals"),
    ordinal: v.number(),
    entries: v.array(manifestEntry),
  }).index("by_deal_ordinal", ["dealId", "ordinal"]),
  placeParticipants: defineTable({
    dealId: v.id("placeDeals"),
    agentId: v.id("agents"),
    ownerId: v.string(),
  })
    .index("by_agent", ["agentId"])
    .index("by_owner", ["ownerId"])
    .index("by_deal_agent", ["dealId", "agentId"]),
  placeReservations: defineTable({
    dealId: v.id("placeDeals"),
    agentId: v.id("agents"),
    ownerId: v.string(),
    cents: v.number(),
    status: v.union(
      v.literal("held"),
      v.literal("released"),
      v.literal("spent")
    ),
  })
    .index("by_agent_status", ["agentId", "status"])
    .index("by_deal", ["dealId"]),
  placeBids: defineTable({
    dealId: v.id("placeDeals"),
    agentId: v.id("agents"),
    amountCents: v.number(),
  }).index("by_deal", ["dealId"]),
  placeTrades: defineTable({
    dealId: v.id("placeDeals"),
    buyerId: v.id("agents"),
    pixelCount: v.number(),
    priceCents: v.number(),
    feeCents: v.number(),
    kind: v.string(),
    sellers: v.array(v.object({ agentId: v.id("agents"), cents: v.number() })),
  })
    .index("by_deal", ["dealId"])
    .index("by_buyer", ["buyerId"]),
  placeOfferLinks: defineTable({
    offerId: v.id("placeDeals"),
    transferId: v.id("placeDeals"),
  })
    .index("by_offer", ["offerId"])
    .index("by_transfer", ["transferId"]),
  placeMemberships: defineTable({
    pixel: v.number(),
    dealId: v.id("placeDeals"),
    version: v.string(),
  })
    .index("by_pixel", ["pixel"])
    .index("by_pixel_version", ["pixel", "version"]),
  placeForfeitures: defineTable({
    banId: v.id("integrityBans"),
    region: v.number(),
    agentId: v.id("agents"),
    ownerId: v.string(),
    pixels: v.array(v.number()),
    dealId: v.optional(v.id("placeDeals")),
  }).index("by_ban_region", ["banId", "region"]),
  integrityBans: defineTable({
    agentId: v.id("agents"),
    ownerId: v.optional(v.string()),
    operatorId: v.string(),
    reason: v.string(),
    evidence: v.array(v.string()),
    cutoff: v.number(),
    phase: v.string(),
    cursor: v.optional(v.string()),
    nextAt: v.number(),
  })
    .index("by_agent", ["agentId"])
    .index("by_phase_next", ["phase", "nextAt"]),
  integrityReviews: defineTable({
    banId: v.optional(v.id("integrityBans")),
    resourceId: v.id("resources"),
    agentId: v.id("agents"),
    reason: v.string(),
    taskId: v.optional(v.id("tasks")),
    status: v.string(),
    active: v.boolean(),
    injection: v.boolean(),
    boundary: v.number(),
    fallbackRevisionId: v.optional(v.id("revisions")),
    inspectedRevisionId: v.optional(v.id("revisions")),
    operatorId: v.optional(v.string()),
    decision: v.optional(v.string()),
  })
    .index("by_ban_resource", ["banId", "resourceId"])
    .index("by_resource", ["resourceId"])
    .index("by_resource_agent", ["resourceId", "agentId"])
    .index("by_resource_active_boundary", [
      "resourceId",
      "active",
      "injection",
      "boundary",
    ])
    .index("by_status", ["status"])
    .index("by_active", ["active"]),
  integrityEvidence: defineTable({
    reviewId: v.id("integrityReviews"),
    revisionId: v.id("revisions"),
  })
    .index("by_review", ["reviewId"])
    .index("by_review_revision", ["reviewId", "revisionId"]),
}
