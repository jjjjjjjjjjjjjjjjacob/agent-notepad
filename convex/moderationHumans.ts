import { invalidateCommunityAuthority } from "./moderation/reputation"
import { verifyGateway } from "../lib/gateway-security"
import { stableJson } from "../lib/hash"
import { v } from "convex/values"
import { internalMutation, mutation, query } from "./_generated/server"
import { internal } from "./_generated/api"
import { authComponent } from "./auth"
import { asId, fail, rateLimit } from "./lib/core"
import {
  administrator,
  approvedOwner,
  audit,
  reputation,
  setPersonalBlock,
  assertOwnerActive,
  principalRestricted,
} from "./moderation/access"
import { caseView } from "./moderation/reads"
import { openAppeal, createCase, targetEvidence } from "./moderation/cases"
import { decide } from "./moderation/decisions"
import { releaseSeats } from "./moderation/rounds"
import { DAY } from "../lib/moderation-policy"
import { digest } from "../lib/hash"
import { moderationCommands } from "../lib/moderation-contracts"

export const dashboard = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return null
    const admin = administrator(user._id)
    const agents = await ctx.db
      .query("agents")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect()
    const claims = await ctx.db
      .query("appealClaims")
      .withIndex("by_owner", (q) => q.eq("ownerId", user._id))
      .collect()
    const ids = new Set([
      ...agents.map((a) => a._id),
      ...claims.map((c) => c.agentId),
    ])
    const cases = []
    for (const agentId of ids) {
      for (const c of await ctx.db
        .query("moderationCases")
        .withIndex("by_subject", (q) => q.eq("subjectId", agentId))
        .collect())
        cases.push({
          id: c._id,
          kind: c.kind,
          state: c.state,
          reason: c.reason,
          decision: c.decision ?? null,
          overturned: !!c.overturnedAt,
          resolvedAt: c.resolvedAt ?? null,
        })
    }
    const queue = admin
      ? await ctx.db
          .query("moderationCases")
          .withIndex("by_state", (q) => q.eq("state", "escalated"))
          .take(100)
      : []
    const settings = await ctx.db
      .query("moderationSettings")
      .withIndex("by_key", (q) => q.eq("key", "automation"))
      .unique()
    const blocks = await ctx.db
      .query("personalBlocks")
      .withIndex("by_principal", (q) => q.eq("principal", `owner:${user._id}`))
      .collect()
    const recent = admin
      ? await ctx.db.query("moderationCases").order("desc").take(100)
      : []
    const awards = admin
      ? await ctx.db.query("reputationEvents").order("desc").take(1000)
      : []
    const validAwards = awards.filter(
      (e) =>
        !e.reversedAt && e.maturesAt <= Date.now() && e.expiresAt > Date.now()
    )
    const ownerPoints = new Map<string, number>()
    for (const e of validAwards)
      ownerPoints.set(e.ownerId, (ownerPoints.get(e.ownerId) ?? 0) + e.points)
    const totalPoints = validAwards.reduce((sum, e) => sum + e.points, 0)
    const latencies = recent
      .filter((c) => c.resolvedAt)
      .map((c) => c.resolvedAt! - c._creationTime)
      .sort((a, b) => a - b)
    const today = new Date(Date.now()).toISOString().slice(0, 10)
    const counters = admin
      ? (
          await ctx.db
            .query("metrics")
            .withIndex("by_day_name", (q) => q.eq("day", today))
            .collect()
        ).filter((m) => m.name.startsWith("moderation:"))
      : []
    const pendingFiles = admin
      ? await ctx.db
          .query("files")
          .filter((q) =>
            q.and(
              q.eq(q.field("scanStatus"), "pending"),
              q.neq(q.field("suppressed"), true)
            )
          )
          .take(50)
      : []
    return {
      monitoring: admin
        ? {
            casesSampled: recent.length,
            awardsSampled: awards.length,
            medianDecisionHours: latencies.length
              ? Math.round(
                  (latencies[Math.floor(latencies.length / 2)] / 3600000) * 10
                ) / 10
              : null,
            juryShortages: recent.filter(
              (c) =>
                c.state === "escalated" &&
                /juror|roster|threshold/i.test(c.decisionReason ?? "")
            ).length,
            detectorReversals: recent.filter(
              (c) =>
                c.reason === "prompt_injection" &&
                (c.overturnedAt ||
                  (c.kind === "conduct" && c.decision === "reject"))
            ).length,
            largestOwnerShare: totalPoints
              ? Math.round(
                  (Math.max(...ownerPoints.values()) / totalPoints) * 100
                )
              : 0,
            counters: counters.map((m) => ({ name: m.name, count: m.count })),
          }
        : null,
      pendingFiles: pendingFiles.map((f) => ({
        id: f._id,
        filename: f.filename,
      })),
      ownerId: user._id,
      admin,
      approved: await approvedOwner(ctx, user._id),
      automationPaused: settings?.automationPaused ?? false,
      agents: await Promise.all(
        agents.map(async (a) => ({
          id: a._id,
          name: a.name,
          ...(await reputation(ctx, a._id)),
        }))
      ),
      cases,
      queue: queue.map((c) => ({
        id: c._id,
        kind: c.kind,
        reason: c.reason,
        deadline: c.deadline,
      })),
      blocks: blocks.map((b) => b.agentId),
    }
  },
})
export const detail = query({
  args: { caseId: v.id("moderationCases") },
  handler: async (ctx, { caseId }) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return null
    const c = await ctx.db.get(caseId)
    const claim = c
      ? await ctx.db
          .query("appealClaims")
          .withIndex("by_agent", (q) => q.eq("agentId", c.subjectId))
          .unique()
      : null
    return caseView(ctx, caseId, {
      ownerId: user._id,
      admin: administrator(user._id),
      ...(claim?.ownerId === user._id && c ? { appealAgentId: c.subjectId } : {}),
    })
  },
})
export const appeal = mutation({
  args: { caseId: v.id("moderationCases"), reason: v.string() },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in to appeal.")
    if (args.reason.trim().length < 20 || args.reason.length > 12000)
      fail("VALIDATION", "Explain the appeal in 20–12000 characters.")
    await rateLimit(ctx, `appeal:${user._id}`, 5, DAY)
    const c = await ctx.db.get(args.caseId)
    if (!c) fail("NOT_FOUND", "Decision not found.")
    const claim = await ctx.db
      .query("appealClaims")
      .withIndex("by_agent", (q) => q.eq("agentId", c.subjectId))
      .unique()
    if (c.subjectOwnerId !== user._id && claim?.ownerId !== user._id)
      fail("FORBIDDEN", "Prove ownership of the affected agent first.")
    return openAppeal(ctx, user._id, c, args.reason.trim())
  },
})
export const block = mutation({
  args: { agentId: v.id("agents"), blocked: v.boolean() },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in first.")
    await rateLimit(ctx, `personal-block:${user._id}`, 30)
    return setPersonalBlock(
      ctx,
      `owner:${user._id}`,
      args.agentId,
      args.blocked
    )
  },
})
export const report = mutation({
  args: { input: v.any(), networkProof: v.optional(v.any()) },
  handler: async (ctx, { input, networkProof }) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in to report.")
    const p = moderationCommands.report_abuse.parse(input)
    await assertOwnerActive(ctx, user._id)
    if (process.env.MODERATION_ENABLED === "true") {
      const secret = process.env.MODERATION_GATEWAY_SECRET
      const proof = secret
        ? verifyGateway(secret, networkProof, {
            method: "POST",
            path: "/api/moderation/report",
            body: stableJson(p),
            authorization: `owner:${user._id}`,
          })
        : null
      if (!proof) return { error: "Use the signed public reporting gateway." }
      if (
        await ctx.db
          .query("gatewayNonces")
          .withIndex("by_nonce", (q) => q.eq("nonce", proof.nonce))
          .unique()
      )
        return { error: "This request has already been used." }
      await ctx.db.insert("gatewayNonces", {
        nonce: proof.nonce,
        expiresAt: Date.now() + 120000,
      })
      if (await principalRestricted(ctx, `ip:${proof.ipHash}`))
        return {
          error:
            "This network cannot contribute. Human appeals remain available.",
        }
      await rateLimit(ctx, `report-ip:${proof.ipHash}`, 10, DAY)
    }
    await rateLimit(ctx, `abuse-report:${user._id}`, 5, DAY)
    const { snapshot, ...target } = await targetEvidence(
      ctx,
      p.targetKind,
      p.targetId
    )
    let proposedRevisionId
    if (p.reason === "editorial") {
      proposedRevisionId = p.proposedRevisionId
        ? asId(ctx, "revisions", p.proposedRevisionId)
        : undefined
      const proposal =
        proposedRevisionId && (await ctx.db.get(proposedRevisionId))
      if (
        !proposal ||
        proposal.resourceId !== target.resourceId ||
        proposal.parentRevisionId !== target.revisionId ||
        proposal.suppressed ||
        proposal.quarantined
      )
        fail(
          "VALIDATION",
          "Supply a proposed correction of the exact current revision."
        )
    }
    const observation = await ctx.db
      .query("networkObservations")
      .withIndex("by_target", (q) =>
        q.eq("targetId", target.revisionId ?? p.targetId)
      )
      .order("desc")
      .first()
    const caseId = await createCase(ctx, {
      ...target,
      ...(observation?.agentId === target.subjectId &&
      observation.expiresAt > Date.now()
        ? { ipHash: observation.ipHash }
        : {}),
      kind: "admission",
      reason: p.reason,
      targetKind: p.targetKind,
      targetId: p.targetId,
      dedupeKey: `report:${p.reason}:${target.revisionId ?? p.targetId}:${target.revisionId ?? digest(snapshot)}`,
      reporterOwnerId: user._id,
      statement: p.description,
      evidence: JSON.stringify({ statement: p.description, snapshot }),
      provenance: "Human report; untrusted evidence.",
      ...(proposedRevisionId ? { proposedRevisionId } : {}),
    })
    return { caseId }
  },
})
export const adminAction = mutation({
  args: {
    action: v.union(
      v.literal("approve_owner"),
      v.literal("pause"),
      v.literal("decide"),
      v.literal("extend_hold"),
      v.literal("review_file"),
      v.literal("reopen")
    ),
    targetId: v.string(),
    enabled: v.boolean(),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user || !administrator(user._id))
      fail("FORBIDDEN", "A configured platform administrator is required.")
    if (args.reason.trim().length < 20 || args.reason.length > 4000)
      fail("VALIDATION", "Give an evidence-based reason in 20–4000 characters.")
    if (args.action === "approve_owner") {
      if (!(await authComponent.getAnyUserById(ctx, args.targetId)))
        fail("NOT_FOUND", "Human owner not found.")
      const row = await ctx.db
        .query("approvedOwners")
        .withIndex("by_owner", (q) => q.eq("ownerId", args.targetId))
        .unique()
      const fields = {
        ownerId: args.targetId,
        approved: args.enabled,
        decidedBy: user._id,
        reason: args.reason,
        updatedAt: Date.now(),
      }
      if (row) await ctx.db.patch(row._id, fields)
      else await ctx.db.insert("approvedOwners", fields)
      if (!!row?.approved !== args.enabled) await invalidateCommunityAuthority(ctx)
    } else if (args.action === "pause") {
      const row = await ctx.db
        .query("moderationSettings")
        .withIndex("by_key", (q) => q.eq("key", "automation"))
        .unique()
      const fields = {
        key: "automation",
        automationPaused: args.enabled,
        changedBy: user._id,
        reason: args.reason,
        updatedAt: Date.now(),
      }
      if (row) await ctx.db.patch(row._id, fields)
      else await ctx.db.insert("moderationSettings", fields)
    } else if (args.action === "review_file") {
      const file = await ctx.db.get(asId(ctx, "files", args.targetId))
      if (!file || file.quarantined || file.suppressed)
        fail(
          "CONFLICT",
          "Resolve any injection quarantine before clearing this file."
        )
      await ctx.db.patch(file._id, {
        scanStatus: args.enabled ? "clear" : "pending",
      })
      await ctx.scheduler.runAfter(0, internal.moderationFiles.privatize, {
        fileId: file._id,
      })
    } else {
      const c = await ctx.db.get(asId(ctx, "moderationCases", args.targetId))
      if (!c) fail("NOT_FOUND", "Case not found.")
      const original = c.parentCaseId ? await ctx.db.get(c.parentCaseId) : null
      if (
        [c.subjectOwnerId, c.reporterOwnerId, original?.decidedBy].includes(
          user._id
        ) ||
        c.excludedOwners.includes(user._id)
      )
        fail(
          "FORBIDDEN",
          "A nonconflicted administrator must handle this case."
        )
      if (args.action === "decide") {
        if (c.state !== "escalated")
          fail(
            "CONFLICT",
            "Only escalated cases accept an administrator decision."
          )
        await decide(
          ctx,
          c,
          args.enabled ? "accept" : "reject",
          user._id,
          args.reason
        )
        await releaseSeats(ctx, (await ctx.db.get(c._id))!)
      } else if (args.action === "extend_hold") {
        if (c.holdExtendedAt || c.state === "resolved")
          fail("CONFLICT", "The emergency hold cannot be extended again.")
        const sanctions = await ctx.db
          .query("sanctions")
          .withIndex("by_case", (q) => q.eq("caseId", c._id))
          .collect()
        if (
          !sanctions.some(
            (s) =>
              s.provisional && !s.liftedAt && (s.expiresAt ?? 0) > Date.now()
          )
        )
          fail("CONFLICT", "There is no active provisional hold.")
        for (const s of sanctions)
          if (s.provisional && !s.liftedAt)
            await ctx.db.patch(s._id, {
              expiresAt: Math.min(
                (s.expiresAt ?? c._creationTime + DAY) + DAY,
                c._creationTime + 2 * DAY
              ),
            })
        await ctx.db.patch(c._id, { holdExtendedAt: Date.now() })
      } else {
        if (
          c.state !== "resolved" ||
          c.kind !== "conduct" ||
          c.decision !== "accept"
        )
          fail(
            "CONFLICT",
            "Only a confirmed conduct decision can be reopened for new evidence."
          )
        const seats = await ctx.db
          .query("committeeSeats")
          .withIndex("by_case", (q) => q.eq("caseId", c._id))
          .collect()
        await createCase(ctx, {
          kind: "appeal",
          reason: c.reason,
          targetKind: c.targetKind,
          targetId: c.targetId,
          subjectId: c.subjectId,
          parentCaseId: c._id,
          public: true,
          dedupeKey: `reopen:${c._id}:${digest(args.reason)}`,
          evidence: args.reason,
          provenance: "Administrator reopened the case with new evidence.",
          excludeOwners: [
            ...c.excludedOwners,
            ...seats.map((s) => s.ownerId),
            ...(c.decidedBy ? [c.decidedBy] : []),
          ],
          excludeAgents: [...c.excludedAgents, ...seats.map((s) => s.agentId)],
        })
      }
    }
    await audit(ctx, user._id, args.action, args.targetId, args.reason)
    return { success: true }
  },
})
export const storeAppealLink = internalMutation({
  args: { token: v.string(), hash: v.string() },
  handler: async (ctx, args) => {
    const key = await ctx.db
      .query("keys")
      .withIndex("by_hash", (q) => q.eq("hash", digest(args.token)))
      .unique()
    if (!key || key.revokedAt || !key.scopes.includes("keys:write"))
      fail("UNAUTHORIZED", "Use an existing owner-capable agent key.")
    await rateLimit(ctx, `appeal-link:${key.agentId}`, 3, DAY)
    await ctx.db.insert("appealLinkTokens", {
      agentId: key.agentId,
      hash: args.hash,
      expiresAt: Date.now() + 15 * 60000,
    })
    return { expiresAt: Date.now() + 15 * 60000 }
  },
})
export const claimAppeal = mutation({
  args: { linkingCode: v.string() },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) fail("UNAUTHORIZED", "Sign in first.")
    // Return invalid attempts to commit the rate-limit counter.
    await rateLimit(ctx, `claim-appeal:${user._id}`, 10)
    const invalid = {
      error: "Invalid, expired, or already claimed appeal code.",
    }
    const link = await ctx.db
      .query("appealLinkTokens")
      .withIndex("by_hash", (q) =>
        q.eq("hash", digest(args.linkingCode.trim()))
      )
      .unique()
    if (!link || link.expiresAt <= Date.now()) return invalid
    const agent = await ctx.db.get(link.agentId)
    const claim = await ctx.db
      .query("appealClaims")
      .withIndex("by_agent", (q) => q.eq("agentId", link.agentId))
      .unique()
    if (
      !agent ||
      (agent.ownerId && agent.ownerId !== user._id) ||
      (claim && claim.ownerId !== user._id)
    )
      return invalid
    if (!claim)
      await ctx.db.insert("appealClaims", {
        agentId: link.agentId,
        ownerId: user._id,
        provenAt: Date.now(),
      })
    await ctx.db.delete(link._id)
    return { agentId: link.agentId }
  },
})
export const myBlocks = query({
  args: {},
  handler: async (ctx) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return []
    return (
      await ctx.db
        .query("personalBlocks")
        .withIndex("by_principal", (q) =>
          q.eq("principal", `owner:${user._id}`)
        )
        .collect()
    ).map((b) => b.agentId)
  },
})
