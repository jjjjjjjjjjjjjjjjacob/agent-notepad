import { internalMutation, internalQuery } from "./_generated/server"
import { v } from "convex/values"
import { requireAgent } from "./lib/core"
import { createCase } from "./moderation/cases"
import { impose } from "./moderation/sanctions"
export const actor = internalQuery({
  args: { token: v.string() },
  handler: async (ctx, { token }) => (await requireAgent(ctx, token)).agent,
})
export const flag = internalMutation({
  args: {
    agentId: v.id("agents"),
    fingerprint: v.string(),
    content: v.string(),
    operation: v.string(),
    assessment: v.string(),
    confidence: v.string(),
    evidenceOnly: v.optional(v.boolean()),
    ipHash: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const high = args.confidence === "HIGH" && !args.evidenceOnly
    const caseId = await createCase(ctx, {
      kind: high ? "conduct" : "admission",
      reason: "prompt_injection",
      targetKind: args.evidenceOnly ? "report" : "agent",
      targetId: `submission:${args.fingerprint}`,
      subjectId: args.agentId,
      dedupeKey: `injection:${args.agentId}:${args.fingerprint}`,
      evidence: args.content,
      provenance: `${args.operation}; ${args.assessment}`,
      public: high,
      ...(args.ipHash ? { ipHash: args.ipHash } : {}),
    })
    const settings = await ctx.db
      .query("moderationSettings")
      .withIndex("by_key", (q) => q.eq("key", "automation"))
      .unique()
    const c = (await ctx.db.get(caseId))!
    if (high && c.state !== "resolved") {
      if (
        !settings?.automationPaused &&
        process.env.MODERATION_ENABLED === "true"
      )
        await impose(ctx, c, true)
      else
        await ctx.db.patch(c._id, {
          state: "escalated",
          decisionReason:
            "Automated sanctions are paused; the submission was not published.",
        })
    }
    // Return normally: throwing here would roll back the sanction and evidence.
    return {
      caseId,
      cleared:
        c.state === "resolved" && (c.decision === "reject" || !!c.overturnedAt),
    }
  },
})
export const attachResult = internalMutation({
  args: { caseId: v.id("moderationCases"), result: v.any() },
  handler: async (ctx, { caseId, result }) => {
    const c = await ctx.db.get(caseId)
    if (!c || !c.targetId.startsWith("submission:") || c.kind !== "admission")
      return
    const revisionId =
      typeof (result.revisionId ?? result.proposedRevisionId) === "string"
        ? ctx.db.normalizeId(
            "revisions",
            result.revisionId ?? result.proposedRevisionId
          )
        : null
    if (revisionId) {
      const revision = await ctx.db.get(revisionId)
      if (revision && revision.authorId === c.subjectId)
        await ctx.db.patch(c._id, {
          targetKind: "revision",
          targetId: revisionId,
          revisionId,
          resourceId: revision.resourceId,
        })
    } else if (typeof result.id === "string") {
      for (const [kind, table] of [
        ["comment", "comments"],
        ["space", "spaces"],
        ["agent", "agents"],
      ] as const) {
        const id = ctx.db.normalizeId(table, result.id)
        if (id) await ctx.db.patch(c._id, { targetKind: kind, targetId: id })
      }
    }
  },
})
export const attachFile = internalMutation({
  args: {
    caseId: v.id("moderationCases"),
    fileId: v.id("files"),
    quarantine: v.optional(v.boolean()),
  },
  handler: async (ctx, { caseId, fileId, quarantine = true }) => {
    const c = await ctx.db.get(caseId)
    if (!c) return
    await ctx.db.patch(c._id, { targetKind: "file", targetId: fileId })
    if (quarantine) {
      await ctx.db.patch(fileId, {
        quarantined: true,
        scanStatus: "quarantined",
      })
      const hold = await ctx.db
        .query("contentHolds")
        .withIndex("by_case", (q) => q.eq("caseId", caseId))
        .filter((q) => q.eq(q.field("targetId"), fileId))
        .first()
      if (!hold)
        await ctx.db.insert("contentHolds", { caseId, targetId: fileId })
    }
  },
})
export const material = internalQuery({
  args: { operation: v.string(), input: v.any() },
  handler: async (ctx, args) => {
    const value =
      args.operation === "revert"
        ? args.input.targetRevisionId
        : args.input.revisionId
    const id =
      typeof value === "string" ? ctx.db.normalizeId("revisions", value) : null
    const revision = id ? await ctx.db.get(id) : null
    return {
      request: args.input,
      restoredContent: revision
        ? {
            title: revision.title,
            body: revision.body,
            citations: revision.citations,
            summary: revision.summary,
          }
        : null,
    }
  },
})
