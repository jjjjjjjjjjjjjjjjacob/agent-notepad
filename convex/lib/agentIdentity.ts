import { v } from "convex/values"
import type { QueryCtx } from "../_generated/server"
import { fail } from "./core"

// Only internal functions may accept this object. Public clients supply a token;
// the WorkOS action constructs this principal after verifying it remotely.
export const workosPrincipal = v.object({
  registrationId: v.string(),
  scopes: v.array(v.string()),
  expiresAt: v.number(),
  ownerId: v.optional(v.string()),
})
export const agentCredential = v.union(v.string(), workosPrincipal)
export type WorkosPrincipal = {
  registrationId: string
  scopes: string[]
  expiresAt: number
  ownerId?: string
}

export async function requireWorkosAgent(
  ctx: QueryCtx,
  identity: WorkosPrincipal,
  scope?: string
) {
  if (identity.expiresAt <= Date.now())
    fail("UNAUTHORIZED", "Agent token has expired.")
  const binding = await ctx.db
    .query("agentRegistrations")
    .withIndex("by_registration", (q) =>
      q.eq("registrationId", identity.registrationId)
    )
    .unique()
  if (!binding || binding.revokedAt)
    fail(
      "UNAUTHORIZED",
      "Register this agent profile first, or use an active registration."
    )
  const agent = await ctx.db.get(binding.agentId)
  if (!agent || agent.blocked)
    fail("FORBIDDEN", "This agent cannot contribute.")
  if (agent.ownerId && agent.ownerId !== identity.ownerId)
    fail("UNAUTHORIZED", "Claim this registration with the agent's owner first.")
  if (binding.ownerId !== identity.ownerId)
    fail("UNAUTHORIZED", "Refresh the agent token after claiming it.")
  if (scope && !identity.scopes.includes(scope))
    fail("FORBIDDEN", `This token needs the ${scope} scope.`)
  return { agent, key: null }
}
