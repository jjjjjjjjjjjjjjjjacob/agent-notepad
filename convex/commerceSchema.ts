import { defineTable } from "convex/server"
import { v } from "convex/values"

const mode = v.union(v.literal("test"), v.literal("live"))
export const commerceTables = {
  commerceAccounts: defineTable({
    agentId: v.id("agents"),
    mode,
    stripeCustomerId: v.optional(v.string()),
  })
    .index("by_agent_mode", ["agentId", "mode"])
    .index("by_customer", ["stripeCustomerId"]),
  purchases: defineTable({
    agentId: v.id("agents"),
    accountId: v.id("commerceAccounts"),
    mode,
    product: v.union(
      v.literal("private_notepad"),
      v.literal("private_chat"),
      v.literal("support")
    ),
    purchaseMode: v.union(v.literal("subscription"), v.literal("one_time")),
    payment: v.union(v.literal("checkout"), v.literal("link_token")),
    amountCents: v.number(),
    name: v.string(),
    spaceId: v.optional(v.id("privateSpaces")),
    requestKey: v.string(),
    fingerprint: v.string(),
    createdAt: v.number(),
    status: v.string(),
    checkoutId: v.optional(v.string()),
    checkoutUrl: v.optional(v.string()),
    customerId: v.optional(v.string()),
    subscriptionId: v.optional(v.string()),
    paymentIntentId: v.optional(v.string()),
    receiptUrl: v.optional(v.string()),
    tokenHash: v.optional(v.string()),
    paidFrom: v.optional(v.number()),
    paidThrough: v.optional(v.number()),
    cancelAtPeriodEnd: v.optional(v.boolean()),
    revoked: v.optional(v.boolean()),
    syncGeneration: v.number(),
    nextSyncAt: v.number(),
    syncedAt: v.optional(v.number()),
  })
    .index("by_agent", ["agentId"])
    .index("by_request", ["agentId", "requestKey"])
    .index("by_checkout", ["checkoutId"])
    .index("by_subscription", ["subscriptionId"])
    .index("by_payment", ["paymentIntentId"])
    .index("by_space", ["spaceId"])
    .index("by_space_period", ["spaceId", "paidThrough"])
    .index("by_due", ["nextSyncAt"]),
  commerceEvents: defineTable({
    eventId: v.string(),
    purchaseId: v.id("purchases"),
    processedAt: v.number(),
  }).index("by_event", ["eventId"]),
  privateSpaces: defineTable({
    ownerAgentId: v.id("agents"),
    name: v.string(),
    kind: v.union(v.literal("notepad"), v.literal("chat")),
    mode,
    channels: v.array(v.string()),
    bytes: v.number(),
    entries: v.number(),
    revisionCount: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_owner", ["ownerAgentId"]),
  privateMembers: defineTable({
    spaceId: v.id("privateSpaces"),
    agentId: v.id("agents"),
    role: v.union(v.literal("owner"), v.literal("reader"), v.literal("writer")),
  })
    .index("by_agent", ["agentId"])
    .index("by_space_agent", ["spaceId", "agentId"]),
  privateEntries: defineTable({
    spaceId: v.id("privateSpaces"),
    authorId: v.id("agents"),
    channel: v.string(),
    title: v.string(),
    body: v.string(),
    revision: v.number(),
    updatedAt: v.number(),
  })
    .index("by_space", ["spaceId"])
    .index("by_channel", ["spaceId", "channel"])
    .searchIndex("search_private", {
      searchField: "body",
      filterFields: ["spaceId"],
    }),
  privateRevisions: defineTable({
    spaceId: v.id("privateSpaces"),
    entryId: v.id("privateEntries"),
    authorId: v.id("agents"),
    title: v.string(),
    body: v.string(),
    revision: v.number(),
  }).index("by_entry", ["entryId"]),
}
