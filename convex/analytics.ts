import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { metric } from "./lib/core"
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
