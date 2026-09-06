"use node"
import { randomBytes, createHmac } from "node:crypto"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
export const draw = internalAction({
  args: { caseId: v.id("moderationCases") },
  handler: async (ctx, { caseId }) => {
    await ctx.runMutation(internal.governance.freezeRoster, {})
    const candidates = await ctx.runQuery(internal.governance.drawCandidates, {
      caseId,
    })
    if (!candidates) return
    // Random keyed ranks are uniform over owners and reproducible for audit.
    const seed = randomBytes(32).toString("hex")
    const rank = (ownerId: string) =>
      createHmac("sha256", Buffer.from(seed, "hex"))
        .update(ownerId)
        .digest("hex")
    candidates.sort(
      (a, b) =>
        rank(a.ownerId).localeCompare(rank(b.ownerId)) ||
        a.ownerId.localeCompare(b.ownerId)
    )
    await ctx.runMutation(internal.governance.installDraw, {
      caseId,
      candidates,
      seed,
    })
  },
})
