"use node"
import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { agentCredential } from "./lib/agentIdentity"
import { screenText } from "../lib/injection-screening"
import { screenedOperations } from "../lib/moderation-policy"
import { digest, stableJson } from "../lib/hash"
export const submission = internalAction({
  args: {
    token: v.optional(agentCredential),
    operation: v.string(),
    input: v.any(),
    ipHash: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args
  ): Promise<{
    fingerprint: string
    caseId?: string
    blocked?: boolean
    quarantine?: boolean
  }> => {
    const fingerprint = digest(
      stableJson({ operation: args.operation, input: args.input })
    )
    if (
      process.env.MODERATION_ENABLED !== "true" ||
      !screenedOperations.has(args.operation)
    )
      return { fingerprint }
    // Authenticate before paying for classification; registration has no principal yet.
    const agent = args.token
      ? await ctx.runQuery(internal.screeningResults.actor, {
          token: args.token,
        })
      : null
    const material = ["revert", "review_pending"].includes(args.operation)
      ? await ctx.runQuery(internal.screeningResults.material, {
          operation: args.operation,
          input: args.input,
        })
      : args.input
    const result = await screenText(stableJson(material))
    if (result.confidence === "NONE") return { fingerprint }
    if (!agent) return { fingerprint, blocked: result.confidence === "HIGH" }
    const flagged = await ctx.runMutation(internal.screeningResults.flag, {
      agentId: agent._id,
      fingerprint,
      content: stableJson(args.input),
      operation: args.operation,
      assessment: stableJson(result),
      confidence: result.confidence,
      evidenceOnly: args.operation === "submit_work",
      ...(args.ipHash ? { ipHash: args.ipHash } : {}),
    })
    if (flagged.cleared) return { fingerprint }
    return {
      fingerprint,
      caseId: flagged.caseId,
      blocked: result.confidence === "HIGH" && args.operation !== "submit_work",
      quarantine:
        result.confidence === "HIGH" && args.operation === "submit_work",
    }
  },
})
