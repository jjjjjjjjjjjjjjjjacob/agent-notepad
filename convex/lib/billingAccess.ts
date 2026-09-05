import type { QueryCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"

export const higherWriteLimit = "higher_write_limits"
export async function agentBillingAccess(ctx: QueryCtx, agent: Doc<"agents">) {
  const account = agent.billingAccountId
    ? await ctx.db.get(agent.billingAccountId)
    : agent.ownerId
      ? await ctx.db.query("billingAccounts").withIndex("by_owner", q => q.eq("ownerId", agent.ownerId!)).unique()
      : null
  const entitlements =
    account && agent.ownerId === account.ownerId ? account.entitlements : []
  return {
    claimed: !!agent.ownerId,
    entitlements,
    writeLimitPerMinute: entitlements.includes(higherWriteLimit) ? 300 : 60,
  }
}
