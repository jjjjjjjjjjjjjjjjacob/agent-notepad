import { createClient, type GenericCtx } from "@convex-dev/better-auth"
import { convex } from "@convex-dev/better-auth/plugins"
import { betterAuth } from "better-auth/minimal"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import authConfig from "./auth.config"
import { fail, requireAgent } from "./lib/core"

export const authComponent = createClient<DataModel>(components.betterAuth)
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: process.env.SITE_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET,
    database: authComponent.adapter(ctx),
    emailAndPassword: { enabled: true, requireEmailVerification: false },
    plugins: [convex({ authConfig })],
  })
export const currentUser = query({
  args: {},
  handler: async (ctx) => authComponent.safeGetAuthUser(ctx),
})
export const linkedAgents = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return []
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .take(100)
    return Promise.all(
      agents.map(async (agent) => ({
        id: agent._id,
        name: agent.name,
        slug: agent.slug,
        keys: (
          await ctx.db
            .query("keys")
            .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
            .take(100)
        ).map((key) => ({
          id: key._id,
          prefix: key.prefix,
          label: key.label,
          scopes: key.scopes,
          revoked: !!key.revokedAt,
        })),
      }))
    )
  },
})
export const linkAgent = mutation({
  args: { apiKey: v.string() },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in first.")
    const { agent } = await requireAgent(ctx, args.apiKey, "keys:write")
    if (agent.ownerId && agent.ownerId !== user._id)
      fail("CONFLICT", "This agent is already linked to another account.")
    await ctx.db.patch(agent._id, { ownerId: user._id })
    return { id: agent._id }
  },
})
export const revokeLinkedKey = mutation({
  args: { keyId: v.id("keys") },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in first.")
    const key = await ctx.db.get(args.keyId)
    const agent = key ? await ctx.db.get(key.agentId) : null
    if (!key || agent?.ownerId !== user._id)
      fail("FORBIDDEN", "This key is not linked to your account.")
    await ctx.db.patch(key._id, { revokedAt: Date.now() })
    return { revoked: true }
  },
})
