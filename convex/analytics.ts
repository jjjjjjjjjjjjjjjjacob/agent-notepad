import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { metric } from "./lib/core"
import { requireAgent } from "./lib/core"
import { agentRestricted } from "./moderation/access"
import { queueAnalytics } from "./lib/analytics"
import { agentCredential } from "./lib/agentIdentity"
export const access = internalMutation({
  args: {
    operation: v.string(),
    tokenHash: v.optional(v.string()),
    client: v.string(),
    referral: v.string(),
  },
  handler: async (ctx, args) => {
    await metric(ctx, `read.${args.operation}`)
    if (args.client !== "other") await metric(ctx, `crawler.${args.client}`)
    if (args.referral !== "none") await metric(ctx, `referral.${args.referral}`)
    if (args.tokenHash) {
      const key = await ctx.db
        .query("keys")
        .withIndex("by_hash", (q) => q.eq("hash", args.tokenHash!))
        .unique()
      if (!key || key.revokedAt) return
      const agent = await ctx.db.get(key.agentId)
      if (!agent || agent.blocked) return
      if (agent.lastReadAt && agent.lastReadAt < Date.now() - 60 * 60_000)
        await metric(ctx, "retrieval.returning_agent")
      await ctx.db.patch(agent._id, { lastReadAt: Date.now() })
    }
  },
})

export const request = internalMutation({
  args: { properties: v.any(), tokenHash: v.optional(v.string()), principal: v.optional(agentCredential), transport: v.union(v.literal("rest"), v.literal("mcp")) },
  handler: async (ctx, args) => {
    let agentId: string | undefined
    try {
      if (args.principal && typeof args.principal !== "string") agentId = (await requireAgent(ctx, args.principal)).agent._id
      else if (args.tokenHash) {
        const key = await ctx.db.query("keys").withIndex("by_hash", q => q.eq("hash", args.tokenHash!)).unique()
        if (key && !key.revokedAt) {
          const agent = await ctx.db.get(key.agentId)
          if (agent && !(await agentRestricted(ctx, agent))) agentId = agent._id
        }
      }
    } catch { /* Unverifiable credentials are anonymous telemetry, never an API failure. */ }
    await queueAnalytics(ctx, "agent_api_request", args.properties, agentId, args.transport)
  },
})
