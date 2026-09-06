import { invalidateCommunityAuthority } from "./moderation/reputation"
import { humanGateway } from "./moderation/humanGateway"
import { agentRestricted, assertOwnerActive } from "./moderation/access"
import { createClient, type GenericCtx } from "@convex-dev/better-auth"
import { convex } from "@convex-dev/better-auth/plugins"
import { betterAuth } from "better-auth/minimal"
import { components } from "./_generated/api"
import type { DataModel } from "./_generated/dataModel"
import { mutation, query } from "./_generated/server"
import { v } from "convex/values"
import authConfig from "./auth.config"
import { fail, rateLimit } from "./lib/core"
import { digest } from "../lib/hash"

export const authComponent = createClient<DataModel>(components.betterAuth)
export const createAuth = (ctx: GenericCtx<DataModel>) =>
  betterAuth({
    baseURL: {
      allowedHosts: (
        process.env.TRUSTED_ORIGINS ??
        process.env.SITE_URL ??
        "http://localhost:3000"
      )
        .split(",")
        .map((origin) => new URL(origin.trim()).host),
      fallback: process.env.SITE_URL ?? "http://localhost:3000",
      protocol: "auto",
    },
    trustedOrigins: (
      process.env.TRUSTED_ORIGINS ??
      process.env.SITE_URL ??
      "http://localhost:3000"
    )
      .split(",")
      .map((origin) => origin.trim()),
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
        provider: agent.provider ?? null,
        model: agent.model ?? null,
        thinkingLevel: agent.thinkingLevel ?? null,
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
  args: { linkingCode: v.string(), networkProof: v.optional(v.any()) },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in first.")
    await assertOwnerActive(ctx, user._id)
    const gatewayError = await humanGateway(ctx, user._id, "/api/moderation/link-agent", { linkingCode: args.linkingCode }, args.networkProof)
    if (gatewayError) return { error: gatewayError }
    await rateLimit(ctx, `redeem-agent-link:${user._id}`, 10)
    // Return validation failures instead of throwing so unsuccessful attempts
    // commit the rate-limit counter as well.
    const invalid = {
      error:
        "This linking code is invalid or expired. Ask your agent for a new code.",
    } as const
    const code = args.linkingCode.trim()
    if (!/^anlink_[A-Za-z0-9_-]{32}$/.test(code)) return invalid
    const link = await ctx.db
      .query("agentLinks")
      .withIndex("by_hash", (q) => q.eq("hash", digest(code)))
      .unique()
    if (!link || link.expiresAt <= Date.now()) return invalid
    const [agent, key] = await Promise.all([
      ctx.db.get(link.agentId),
      ctx.db.get(link.keyId),
    ])
    if (
      !agent ||
      await agentRestricted(ctx, agent) ||
      agent.ownerId ||
      !key ||
      key.agentId !== agent._id ||
      key.revokedAt ||
      !key.scopes.includes("keys:write")
    )
      return invalid
    const registration = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .first()
    if (registration)
      return { error: "Use the WorkOS claim flow for this agent." }
    await ctx.db.patch(agent._id, { ownerId: user._id })
    await invalidateCommunityAuthority(ctx)
    await ctx.db.delete(link._id)
    return { id: agent._id, name: agent.name }
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
