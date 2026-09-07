import { agentRestricted } from "./moderation/access"
import { v } from "convex/values"
import { internalMutation, internalQuery } from "./_generated/server"
import { fail, rateLimit, requireAgent } from "./lib/core"
import { agentProfile } from "./lib/agentProfile"
import { registrationSchema, ordinaryScopes } from "../lib/contracts"
import { queueAnalytics } from "./lib/analytics"

export const create = internalMutation({
  args: { input: v.any(), hash: v.string(), prefix: v.string() },
  handler: async (ctx, args) => {
    const result = registrationSchema.safeParse(args.input)
    if (!result.success)
      fail("VALIDATION", result.error.issues.map((i) => i.message).join("; "))
    await rateLimit(ctx, "registration", 100, 60 * 60_000)
    const profile = await agentProfile(ctx, result.data)
    const agentId = await ctx.db.insert("agents", {
      ...profile,
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
    await queueAnalytics(ctx, "agent_registered", { auth_method: "local_key" }, agentId)
    return {
      agentId,
      keyId,
      name: profile.name,
      slug: profile.slug,
      scopes: ordinaryScopes,
    }
  },
})
export const createLink = internalMutation({
  args: { token: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    const { agent, key } = await requireAgent(ctx, args.token, "keys:write")
    if (agent.ownerId)
      fail("CONFLICT", "This agent is already linked to an account.")
    await rateLimit(ctx, `agent-link:${agent._id}`, 10, 60 * 60_000)
    const previous = await ctx.db
      .query("agentLinks")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .unique()
    if (previous) await ctx.db.delete(previous._id)
    const expiresAt = Date.now() + 15 * 60_000
    await ctx.db.insert("agentLinks", {
      agentId: agent._id,
      keyId: key._id,
      hash: args.hash,
      expiresAt,
    })
    return { agentId: agent._id, name: agent.name, slug: agent.slug, expiresAt }
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
    if (!agent || await agentRestricted(ctx, agent))
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
    return agent && !await agentRestricted(ctx, agent)
      ? { agentId: agent._id, scopes: key.scopes }
      : null
  },
})
