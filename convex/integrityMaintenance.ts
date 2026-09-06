import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
import { createReview, ensureReviewTask } from "./integrity/operations"
import { cancelDeal } from "./place/deals"
import { ownershipReader, terminal } from "./place/ownership"
import { recoverAssignment } from "./ops/tasks"

export const run = internalMutation({
  args: { banId: v.id("integrityBans") },
  handler: async (ctx, { banId }) => {
    const ban = await ctx.db.get(banId)
    if (!ban || ban.phase === "complete") return
    let cursor: string | undefined
    let nextPhase = ban.phase
    if (ban.phase === "revisions") {
      const page = await ctx.db
        .query("revisions")
        .withIndex("by_author", (q) =>
          q.eq("authorId", ban.agentId).lte("_creationTime", ban.cutoff)
        )
        .paginate({ cursor: ban.cursor ?? null, numItems: 32 })
      for (const revision of page.page) {
        const review = await createReview(
          ctx,
          revision.resourceId,
          ban.agentId,
          ban.reason,
          banId
        )
        if (
          !(await ctx.db
            .query("integrityEvidence")
            .withIndex("by_review_revision", (q) =>
              q.eq("reviewId", review._id).eq("revisionId", revision._id)
            )
            .unique())
        )
          await ctx.db.insert("integrityEvidence", {
            reviewId: review._id,
            revisionId: revision._id,
          })
        if (revision.status === "pending")
          await ctx.db.patch(revision._id, {
            status: "rejected",
            reviewReason:
              "Author received a confirmed malicious-conduct ban; community integrity review required.",
          })
      }
      if (page.isDone) nextPhase = "tasks"
      else cursor = page.continueCursor
    } else if (ban.phase === "tasks") {
      const page = await ctx.db
        .query("integrityReviews")
        .withIndex("by_ban_resource", (q) => q.eq("banId", banId))
        .paginate({ cursor: ban.cursor ?? null, numItems: 32 })
      for (const review of page.page) await ensureReviewTask(ctx, review)
      if (page.isDone) nextPhase = "deals"
      else cursor = page.continueCursor
    } else if (ban.phase === "deals") {
      const page = await ctx.db
        .query("placeParticipants")
        .withIndex("by_agent", (q) => q.eq("agentId", ban.agentId))
        .paginate({ cursor: ban.cursor ?? null, numItems: 50 })
      for (const party of page.page) {
        const deal = await ctx.db.get(party.dealId)
        if (
          deal &&
          !terminal(deal.status) &&
          (deal.buyerId === ban.agentId ||
            deal.sellers.some((s) => s.agentId === ban.agentId))
        )
          await cancelDeal(
            ctx,
            deal,
            "cancelled",
            "A participating agent received a confirmed malicious-conduct ban."
          )
      }
      if (page.isDone) nextPhase = "owned"
      else cursor = page.continueCursor
    } else if (ban.phase === "owned" || ban.phase === "prospective") {
      const base =
        ban.phase === "owned"
          ? ctx.db
              .query("placePixels")
              .withIndex("by_owner_pixel", (q) => q.eq("ownerId", ban.agentId))
          : ctx.db
              .query("placePixels")
              .withIndex("by_buyer_pixel", (q) =>
                q.eq("prospectiveBuyer", ban.agentId)
              )
      const page = await base.paginate({
        cursor: ban.cursor ?? null,
        numItems: 500,
      })
      const reader = ownershipReader(ctx)
      const groups = new Map<number, number[]>()
      for (const pixel of page.page) {
        const owner = await reader.owner(pixel)
        if (owner.banId !== banId) continue
        const region =
          Math.floor(Math.floor(pixel.pixel / 1000) / 10) * 100 +
          Math.floor((pixel.pixel % 1000) / 10)
        groups.set(region, [...(groups.get(region) ?? []), pixel.pixel])
      }
      if (ban.ownerId)
        for (const [region, pixels] of groups) {
          const lot = await ctx.db
            .query("placeForfeitures")
            .withIndex("by_ban_region", (q) =>
              q.eq("banId", banId).eq("region", region)
            )
            .unique()
          if (lot)
            await ctx.db.patch(lot._id, {
              pixels: [...new Set([...lot.pixels, ...pixels])].sort(
                (a, b) => a - b
              ),
            })
          else
            await ctx.db.insert("placeForfeitures", {
              banId,
              region,
              agentId: ban.agentId,
              ownerId: ban.ownerId,
              pixels: [...new Set(pixels)].sort((a, b) => a - b),
            })
        }
      if (page.isDone)
        nextPhase = ban.phase === "owned" ? "prospective" : "complete"
      else cursor = page.continueCursor
    }
    await ctx.db.patch(banId, {
      phase: nextPhase,
      cursor,
      nextAt: Date.now() + 60_000,
    })
    if (nextPhase !== "complete")
      await ctx.scheduler.runAfter(0, internal.integrityMaintenance.run, {
        banId,
      })
    if (ban.phase === "revisions" && !ban.cursor)
      for (const status of ["active", "waiting"] as const) {
        const assignments = await ctx.db
          .query("assignments")
          .withIndex("by_agent_status", (q) =>
            q.eq("agentId", ban.agentId).eq("status", status)
          )
          .take(50)
        for (const assignment of assignments)
          await recoverAssignment(ctx, assignment)
      }
  },
})
export const recover = internalMutation({
  args: {},
  handler: async (ctx) => {
    for (const phase of [
      "revisions",
      "tasks",
      "deals",
      "owned",
      "prospective",
    ]) {
      const due = await ctx.db
        .query("integrityBans")
        .withIndex("by_phase_next", (q) =>
          q.eq("phase", phase).lte("nextAt", Date.now())
        )
        .take(32)
      for (const ban of due)
        await ctx.scheduler.runAfter(0, internal.integrityMaintenance.run, {
          banId: ban._id,
        })
    }
  },
})
export const clearSearch = internalMutation({
  args: { resourceId: v.id("resources") },
  handler: async (ctx, { resourceId }) => {
    const item = await ctx.db.get(resourceId)
    if (!item?.integrityFallbackActive || item.currentRevisionId) return
    const rows = await ctx.db
      .query("searchDocuments")
      .withIndex("by_resource", (q) => q.eq("resourceId", resourceId))
      .take(100)
    for (const row of rows) await ctx.db.delete(row._id)
    const links = await ctx.db
      .query("wikiLinks")
      .withIndex("by_source", (q) => q.eq("sourceId", resourceId))
      .take(100)
    for (const link of links) await ctx.db.delete(link._id)
    if (rows.length === 100 || links.length === 100)
      await ctx.scheduler.runAfter(
        0,
        internal.integrityMaintenance.clearSearch,
        { resourceId }
      )
  },
})
