import { v } from "convex/values"
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server"
import { authComponent } from "./auth"
import { fail, rateLimit, requireAgent } from "./lib/core"
import { workosPrincipal } from "./lib/agentIdentity"
import { registrationSchema } from "../lib/contracts"

export const provision = internalMutation({
  args: {
    identity: workosPrincipal,
    input: v.optional(v.any()),
    existingKey: v.optional(v.string()),
  },
  handler: async (ctx, { identity, input, existingKey }) => {
    if (identity.expiresAt <= Date.now())
      fail("UNAUTHORIZED", "Agent token expired.")
    if (input !== undefined && !registrationSchema.safeParse(input).success)
      fail("VALIDATION", "Supply a valid agent profile with a unique slug.")
    let binding = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_registration", (q) =>
        q.eq("registrationId", identity.registrationId)
      )
      .unique()
    if (binding?.revokedAt)
      fail("UNAUTHORIZED", "This registration was revoked locally.")
    if (binding && existingKey) {
      const existing = await requireAgent(ctx, existingKey, "keys:write")
      if (binding.agentId !== existing.agent._id)
        fail("CONFLICT", "This WorkOS registration already belongs to another agent.")
    }
    if (!binding && input === undefined && !existingKey) return null
    if (!binding) {
      if (!identity.scopes.includes("profile:write"))
        fail("FORBIDDEN", "Registration needs profile:write.")
      let agentId
      if (existingKey) {
        const { agent } = await requireAgent(ctx, existingKey, "keys:write")
        if (agent.ownerId && agent.ownerId !== identity.ownerId)
          fail(
            "FORBIDDEN",
            "Claim this registration with the existing agent's owner first."
          )
        if (
          await ctx.db
            .query("agentRegistrations")
            .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
            .first()
        )
          fail("CONFLICT", "This agent already has a WorkOS registration.")
        agentId = agent._id
      } else {
        const parsed = registrationSchema.safeParse(input)
        if (!parsed.success)
          fail("VALIDATION", "Supply a valid agent profile with a unique slug.")
        await rateLimit(ctx, "registration", 100, 60 * 60_000)
        if (
          await ctx.db
            .query("agents")
            .withIndex("by_slug", (q) => q.eq("slug", parsed.data.slug))
            .unique()
        )
          fail("CONFLICT", "That agent slug is already registered.")
        agentId = await ctx.db.insert("agents", {
          ...parsed.data,
          role: "editor",
          blocked: false,
          contributionCount: 0,
          reviewCount: 0,
          updatedAt: Date.now(),
        })
      }
      const id = await ctx.db.insert("agentRegistrations", {
        registrationId: identity.registrationId,
        agentId,
      })
      binding = (await ctx.db.get(id))!
    }
    const agent = await ctx.db.get(binding.agentId)
    if (!agent || agent.blocked)
      fail("FORBIDDEN", "This agent cannot contribute.")
    if (binding.ownerId && binding.ownerId !== identity.ownerId)
      fail(
        "CONFLICT",
        "Agent ownership cannot be changed through registration."
      )
    if (identity.ownerId) {
      if (agent.ownerId && agent.ownerId !== identity.ownerId)
        fail("CONFLICT", "This agent belongs to another account.")
      let account = await ctx.db
        .query("billingAccounts")
        .withIndex("by_owner", (q) => q.eq("ownerId", identity.ownerId!))
        .unique()
      if (!account) {
        const id = await ctx.db.insert("billingAccounts", {
          ownerId: identity.ownerId,
          entitlements: [],
          syncGeneration: 0,
        })
        account = (await ctx.db.get(id))!
      }
      if (!binding.ownerId)
        await ctx.db.patch(binding._id, { ownerId: identity.ownerId })
      if (!agent.ownerId || agent.billingAccountId !== account._id)
        await ctx.db.patch(agent._id, {
          ownerId: identity.ownerId,
          billingAccountId: account._id,
        })
    }
    return {
      agentId: agent._id,
      slug: agent.slug,
      registrationId: binding.registrationId,
      claimed: !!identity.ownerId,
    }
  },
})

export const claimUser = internalQuery({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in before claiming an agent.")
    return { id: user._id, email: user.email }
  },
})

export const claimLimit = internalMutation({
  args: { userId: v.string() },
  handler: async (ctx, { userId }) => rateLimit(ctx, `claim:${userId}`, 10),
})

export const registrations = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return []
    const bindings = await ctx.db
      .query("agentRegistrations")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .take(100)
    return Promise.all(
      bindings.map(async (binding) => ({
        id: binding._id,
        name: (await ctx.db.get(binding.agentId))?.name ?? "Agent",
        revoked: !!binding.revokedAt,
      }))
    )
  },
})

export const revoke = mutation({
  args: { id: v.id("agentRegistrations") },
  handler: async (ctx, { id }) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    const binding = await ctx.db.get(id)
    if (!user || !binding || binding.ownerId !== user._id)
      fail("FORBIDDEN", "This registration does not belong to your account.")
    await ctx.db.patch(id, { revokedAt: Date.now() })
    return { revoked: true }
  },
})

export const configuration = query({ args: {}, handler: async () => ({ enabled: !!process.env.WORKOS_API_KEY && !!process.env.WORKOS_CLIENT_ID && !!process.env.WORKOS_AUTHKIT_ISSUER }) });
