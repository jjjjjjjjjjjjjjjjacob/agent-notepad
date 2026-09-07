import type { QueryCtx } from "./_generated/server"
import type { Doc, Id } from "./_generated/dataModel"
import { authComponent } from "./auth"
import { agentRestricted } from "./moderation/access"
import { asId, fail } from "./lib/core"
import { commerceMode } from "../lib/commerce"

export async function humanAgent(ctx: QueryCtx, agentId: string) {
  const user = await authComponent.safeGetAuthUser(ctx)
  if (!user) fail("UNAUTHORIZED", "Sign in to manage a linked agent.")
  const agent = await ctx.db.get(asId(ctx, "agents", agentId))
  if (
    !agent ||
    agent.ownerId !== user._id ||
    (await agentRestricted(ctx, agent))
  )
    fail("FORBIDDEN", "This agent is not available to this account.")
  return agent
}

export async function serviceAccess(
  ctx: QueryCtx,
  space: Doc<"privateSpaces">
) {
  const grants = await ctx.db
    .query("purchases")
    .withIndex("by_space_period", (q) =>
      q.eq("spaceId", space._id).gt("paidThrough", Date.now())
    )
    .take(25)
  const active = grants.filter(
    (p) =>
      !p.revoked &&
      p.mode === space.mode &&
      (p.paidFrom ?? Infinity) <= Date.now()
  )
  return {
    writable: space.mode === commerceMode() && active.length > 0,
    paidThrough: active.length
      ? Math.max(...active.map((p) => p.paidThrough!))
      : null,
  }
}

export async function privateAccess(
  ctx: QueryCtx,
  agent: Doc<"agents">,
  spaceId: string,
  permission: "read" | "write" | "owner" = "read"
) {
  const space = await ctx.db.get(asId(ctx, "privateSpaces", spaceId))
  if (!space) fail("NOT_FOUND", "Private space not found.")
  const membership = await ctx.db
    .query("privateMembers")
    .withIndex("by_space_agent", (q) =>
      q.eq("spaceId", space._id).eq("agentId", agent._id)
    )
    .unique()
  if (!membership) fail("NOT_FOUND", "Private space not found.")
  if (permission === "owner" && space.ownerAgentId !== agent._id)
    fail("FORBIDDEN", "Only the owning agent can manage this space.")
  if (permission === "write") {
    if (membership.role === "reader")
      fail("FORBIDDEN", "This membership is read-only.")
    const owner = await ctx.db.get(space.ownerAgentId)
    if (
      !owner ||
      (await agentRestricted(ctx, owner)) ||
      !(await serviceAccess(ctx, space)).writable
    )
      fail("FORBIDDEN", "This space is read-only. Its owner can renew access.")
  }
  return { space, membership }
}

export async function purchaseForAgent(
  ctx: QueryCtx,
  agentId: Id<"agents">,
  id: string
) {
  const purchase = await ctx.db.get(asId(ctx, "purchases", id))
  if (!purchase || purchase.agentId !== agentId)
    fail("NOT_FOUND", "Purchase not found.")
  return purchase
}
