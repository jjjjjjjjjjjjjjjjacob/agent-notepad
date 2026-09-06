import { ConvexError } from "convex/values"
import type { QueryCtx, MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { DAY } from "../../lib/moderation-policy"

export async function principalRestricted(ctx: QueryCtx, principal: string) {
  const now = Date.now()
  return !!(await ctx.db
    .query("sanctions")
    .withIndex("by_principal", (q) => q.eq("principal", principal))
    .filter((q) =>
      q.and(
        q.eq(q.field("liftedAt"), undefined),
        q.or(
          q.eq(q.field("expiresAt"), undefined),
          q.gt(q.field("expiresAt"), now)
        )
      )
    )
    .first())
}
export async function agentRestricted(ctx: QueryCtx, agent: Doc<"agents">) {
  return (
    agent.blocked ||
    !!agent.maliciousBanId ||
    (await principalRestricted(ctx, `agent:${agent._id}`)) ||
    (!!agent.ownerId &&
      (await principalRestricted(ctx, `owner:${agent.ownerId}`)))
  )
}
export async function assertOwnerActive(ctx: QueryCtx, ownerId?: string) {
  if (ownerId && (await principalRestricted(ctx, `owner:${ownerId}`)))
    throw new ConvexError({
      code: "FORBIDDEN",
      message: "This owner cannot contribute. Human appeals remain available.",
    })
}
export async function approvedOwner(ctx: QueryCtx, ownerId?: string) {
  return (
    !!ownerId &&
    !!(
      await ctx.db
        .query("approvedOwners")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .unique()
    )?.approved &&
    !(await principalRestricted(ctx, `owner:${ownerId}`))
  )
}
export async function hasHold(ctx: QueryCtx, targetId: string) {
  return !!(await ctx.db
    .query("contentHolds")
    .withIndex("by_target", (q) => q.eq("targetId", targetId))
    .filter((q) => q.eq(q.field("liftedAt"), undefined))
    .first())
}
export async function blockedFor(
  ctx: QueryCtx,
  principal: string,
  agentId?: Id<"agents">
) {
  return (
    !!agentId &&
    !!(await ctx.db
      .query("personalBlocks")
      .withIndex("by_principal_agent", (q) =>
        q.eq("principal", principal).eq("agentId", agentId)
      )
      .unique())
  )
}
export async function setPersonalBlock(
  ctx: MutationCtx,
  principal: string,
  agentId: Id<"agents">,
  blocked: boolean
) {
  if (!(await ctx.db.get(agentId)))
    throw new ConvexError({ code: "NOT_FOUND", message: "Agent not found." })
  const row = await ctx.db
    .query("personalBlocks")
    .withIndex("by_principal_agent", (q) =>
      q.eq("principal", principal).eq("agentId", agentId)
    )
    .unique()
  if (blocked && !row)
    await ctx.db.insert("personalBlocks", { principal, agentId })
  if (!blocked && row) await ctx.db.delete(row._id)
  return { agentId, blocked }
}
export async function reputation(ctx: QueryCtx, agentId: Id<"agents">) {
  const now = Date.now()
  const rows = await ctx.db
    .query("reputationEvents")
    .withIndex("by_agent", (q) => q.eq("agentId", agentId))
    .filter((q) =>
      q.and(
        q.eq(q.field("reversedAt"), undefined),
        q.gt(q.field("expiresAt"), now)
      )
    )
    .collect()
  for (let i = rows.length - 1; i >= 0; i--) {
    const e = rows[i]
    const item = e.resourceId ? await ctx.db.get(e.resourceId) : null
    const rev = e.revisionId ? await ctx.db.get(e.revisionId) : null
    if (
      (e.resourceId && (!item || item.suppressed || item.quarantined)) ||
      (e.revisionId && (!rev || rev.suppressed || rev.quarantined))
    )
      rows.splice(i, 1)
  }
  const agent = await ctx.db.get(agentId)
  const restricted = !agent || (await agentRestricted(ctx, agent))
  return {
    score: restricted
      ? 0
      : Math.min(
          100,
          rows
            .filter((e) => e.maturesAt <= now)
            .reduce((n, e) => n + e.points, 0)
        ),
    pending: restricted
      ? 0
      : rows.filter((e) => e.maturesAt > now).reduce((n, e) => n + e.points, 0),
  }
}
export async function contributorStatus(ctx: QueryCtx, agent: Doc<"agents">) {
  const cases = await ctx.db
    .query("moderationCases")
    .withIndex("by_subject", (q) => q.eq("subjectId", agent._id))
    .filter((q) =>
      q.and(
        q.eq(q.field("public"), true),
        q.eq(q.field("overturnedAt"), undefined)
      )
    )
    .collect()
  if (agent.blocked || agent.maliciousBanId) return "removed" as const
  for (const principal of [
    `agent:${agent._id}`,
    ...(agent.ownerId ? [`owner:${agent.ownerId}`] : []),
  ]) {
    const confirmed = await ctx.db
      .query("sanctions")
      .withIndex("by_principal", (q) => q.eq("principal", principal))
      .filter((q) =>
        q.and(
          q.eq(q.field("provisional"), false),
          q.eq(q.field("liftedAt"), undefined)
        )
      )
      .collect()
    if (confirmed.some((s) => !s.expiresAt || s.expiresAt > Date.now()))
      return "removed" as const
  }
  if (
    cases.some(
      (c) => ["conduct", "editorial"].includes(c.kind) && c.state !== "resolved"
    )
  )
    return "investigating" as const
  if (cases.some((c) => c.kind === "conduct" && c.decision === "accept"))
    return "removed" as const
  return "clear" as const
}
export function administrator(ownerId: string) {
  return (process.env.MODERATION_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .includes(ownerId)
}
export async function audit(
  ctx: MutationCtx,
  actor: string,
  action: string,
  targetId: string,
  reason: string
) {
  await ctx.db.insert("moderationAudit", { actor, action, targetId, reason })
  const day = new Date(Date.now()).toISOString().slice(0, 10),
    name = `moderation:${action}`
  const current = await ctx.db
    .query("metrics")
    .withIndex("by_day_name", (q) => q.eq("day", day).eq("name", name))
    .unique()
  if (current) await ctx.db.patch(current._id, { count: current.count + 1 })
  else await ctx.db.insert("metrics", { day, name, count: 1 })
}
export async function observe(
  ctx: MutationCtx,
  ipHash: string,
  agentId?: Id<"agents">,
  targetId?: string
) {
  await ctx.db.insert("networkObservations", {
    ipHash,
    ...(agentId ? { agentId } : {}),
    ...(targetId ? { targetId } : {}),
    expiresAt: Date.now() + 30 * DAY,
  })
}
