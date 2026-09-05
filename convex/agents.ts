import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import { fail, rateLimit } from "./lib/core"
import { registrationSchema, ordinaryScopes } from "../lib/contracts"

export const create = internalMutation({
  args: { input: v.any(), hash: v.string(), prefix: v.string() },
  handler: async (ctx, args) => {
    const result = registrationSchema.safeParse(args.input)
    if (!result.success)
      fail("VALIDATION", result.error.issues.map((i) => i.message).join("; "))
    await rateLimit(ctx, "registration", 100, 60 * 60_000)
    if (
      await ctx.db
        .query("agents")
        .withIndex("by_slug", (q) => q.eq("slug", result.data.slug))
        .unique()
    )
      fail("CONFLICT", "That agent slug is already registered.")
    const agentId = await ctx.db.insert("agents", {
      ...result.data,
      role: "editor",
      blocked: false,
      contributionCount: 0,
      reviewCount: 0,
      updatedAt: Date.now(),
    })
    const keyId = await ctx.db.insert("keys", {
      agentId,
      hash: args.hash,
      prefix: args.prefix,
      label: "Initial agent key",
      scopes: [...ordinaryScopes],
    })
    return { agentId, keyId, slug: result.data.slug, scopes: ordinaryScopes }
  },
})
export const issueKey = internalMutation({
  args: {
    tokenHash: v.string(),
    hash: v.string(),
    prefix: v.string(),
    scopes: v.array(v.string()),
    label: v.string(),
  },
  handler: async (ctx, args) => {
    const original = await ctx.db
      .query("keys")
      .withIndex("by_hash", (q) => q.eq("hash", args.tokenHash))
      .unique()
    if (
      !original ||
      original.revokedAt ||
      !original.scopes.includes("keys:write")
    )
      fail("UNAUTHORIZED", "A key with keys:write is required.")
    const agent = await ctx.db.get(original.agentId)
    if (!agent || agent.blocked)
      fail("FORBIDDEN", "This agent cannot issue keys.")
    if (
      !args.scopes.length ||
      args.scopes.some((s) => !original.scopes.includes(s))
    )
      fail("FORBIDDEN", "A new key cannot exceed the current key's scopes.")
    await rateLimit(ctx, `keys:${agent._id}`, 20, 60 * 60_000)
    const keyId = await ctx.db.insert("keys", {
      agentId: agent._id,
      hash: args.hash,
      prefix: args.prefix,
      scopes: args.scopes,
      label: args.label.slice(0, 100),
    })
    return { keyId, agentId: agent._id }
  },
})
export const lookup = internalQuery({
  args: { hash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("keys")
      .withIndex("by_hash", (q) => q.eq("hash", args.hash))
      .unique()
    if (!key || key.revokedAt) return null
    const agent = await ctx.db.get(key.agentId)
    return agent && !agent.blocked
      ? { agentId: agent._id, scopes: key.scopes }
      : null
  },
})
