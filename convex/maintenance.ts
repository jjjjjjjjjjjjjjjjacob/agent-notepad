import { internalMutation, internalQuery } from "./_generated/server"
import { internal } from "./_generated/api"
import { batchState, requestBatch, scheduleBatch } from "./lib/batches"
import { commerceConfigured } from "../lib/commerce"
import { armLease } from "./lib/leaseTimers"
import { armCaseDeadline } from "./moderation/timers"

// Optional fields make the first deployment schema-compatible. Explicitly arm
// legacy records before retiring their minute-based recovery safety net.
export const rearm = internalMutation({
  args: {},
  handler: async (ctx) => {
    let armed = 0
    let more = false
    for (const status of ["active", "waiting"] as const) {
      const leases = await ctx.db
        .query("assignments")
        .withIndex("by_status_timer", (q) =>
          q.eq("status", status).eq("expiryGeneration", undefined)
        )
        .take(32)
      for (const lease of leases) {
        await armLease(ctx, lease)
        armed++
      }
      more ||= leases.length === 32
    }
    for (const state of ["queued", "seating", "voting"] as const) {
      const cases = await ctx.db
        .query("moderationCases")
        .withIndex("by_state_wake", (q) =>
          q.eq("state", state).eq("roundJobDueAt", undefined)
        )
        .take(30)
      for (const c of cases) {
        // Legacy callbacks already carry a generation; replacing it makes them
        // harmless without having to enumerate the old scheduler queue.
        await ctx.db.patch(c._id, { roundJobPending: false })
        await armCaseDeadline(ctx, c._id)
        armed++
      }
      more ||= cases.length === 30
    }
    if (
      await ctx.db
        .query("assignments")
        .withIndex("by_status", (q) => q.eq("status", "waiting"))
        .first()
    )
      await requestBatch(ctx, "matching")
    if (
      await ctx.db
        .query("indexNotifications")
        .withIndex("by_status", (q) => q.eq("status", "pending"))
        .first()
    )
      await requestBatch(ctx, "indexnow")
    if (more) await ctx.scheduler.runAfter(100, internal.maintenance.rearm, {})
    return { armed, more }
  },
})

export const status = internalQuery({
  args: {},
  handler: async (ctx) => {
    const unarmed = []
    for (const status of ["active", "waiting"] as const) {
      if (
        await ctx.db
          .query("assignments")
          .withIndex("by_status_timer", (q) =>
            q.eq("status", status).eq("expiryGeneration", undefined)
          )
          .first()
      )
        unarmed.push(`assignments:${status}`)
    }
    for (const state of ["queued", "seating", "voting"] as const) {
      if (
        await ctx.db
          .query("moderationCases")
          .withIndex("by_state_wake", (q) =>
            q.eq("state", state).eq("roundJobDueAt", undefined)
          )
          .first()
      )
        unarmed.push(`cases:${state}`)
    }
    const batches = []
    for (const name of ["matching", "indexnow"] as const) {
      const batch = await ctx.db
        .query("maintenanceBatches")
        .withIndex("by_name", (q) => q.eq("name", name))
        .unique()
      const call = batch?.scheduledId
        ? await ctx.db.system.get(batch.scheduledId)
        : null
      batches.push({
        name,
        generation: batch?.generation ?? 0,
        pending: !!batch?.scheduledId,
        nextAt: batch?.nextAt,
        state: call?.state.kind,
      })
    }
    return { timersArmed: !unarmed.length, unarmed, batches }
  },
})

// Only indexed existence probes belong here. Domain work keeps its own bounded
// transaction, failure boundary, and lease. Empty domains incur no child calls.
export const watchdog = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now()
    let dispatched = 0
    for (const name of ["matching", "indexnow"] as const) {
      const batch = await batchState(ctx, name)
      if (!batch?.scheduledId || batch.nextAt > now - 60_000) continue
      const call = await ctx.db.system.get(batch.scheduledId)
      if (call && ["pending", "inProgress"].includes(call.state.kind)) continue
      await scheduleBatch(ctx, batch, 0)
      dispatched++
    }
    if (
      process.env.INDEXNOW_KEY &&
      process.env.SITE_URL?.startsWith("https://")
    ) {
      const batch = await batchState(ctx, "indexnow")
      if (
        !batch?.scheduledId &&
        (await ctx.db
          .query("indexNotifications")
          .withIndex("by_status", (q) => q.eq("status", "pending"))
          .first())
      ) {
        await requestBatch(ctx, "indexnow", 0)
        dispatched++
      }
    }
    let leases = false
    for (const status of ["active", "waiting"] as const) {
      leases ||= !!(await ctx.db
        .query("assignments")
        .withIndex("by_status_expiry", (q) =>
          q.eq("status", status).lte("expiresAt", now)
        )
        .first())
      leases ||= !!(await ctx.db
        .query("assignments")
        .withIndex("by_status_timer", (q) =>
          q.eq("status", status).eq("expiryGeneration", undefined)
        )
        .first())
    }
    if (leases) {
      await ctx.scheduler.runAfter(0, internal.work.recover, {})
      dispatched++
    }
    for (const state of ["queued", "seating", "voting"] as const) {
      if (
        await ctx.db
          .query("moderationCases")
          .withIndex("by_state_wake", (q) =>
            q.eq("state", state).lte("roundJobDueAt", now - 60_000)
          )
          .first()
      ) {
        await ctx.scheduler.runAfter(0, internal.governance.recover, {
          state,
          dueOnly: true,
        })
        dispatched++
      }
    }
    const reputation = await ctx.db
      .query("communityReputationState")
      .withIndex("by_key", (q) => q.eq("key", "global"))
      .unique()
    if (
      (reputation?.sweepRunning && reputation.sweepNextAt <= now) ||
      (await ctx.db
        .query("communityRecomputeJobs")
        .withIndex("by_running_next", (q) =>
          q.eq("running", true).lte("nextAt", now)
        )
        .first()) ||
      (await ctx.db
        .query("communityRecomputeJobs")
        .withIndex("by_phase_next", (q) =>
          q.eq("phase", "park").lte("nextAt", now)
        )
        .first())
    ) {
      await ctx.scheduler.runAfter(0, internal.communityReputation.recover, {})
      dispatched++
    }
    for (const phase of [
      "revisions",
      "tasks",
      "deals",
      "owned",
      "prospective",
    ]) {
      if (
        await ctx.db
          .query("integrityBans")
          .withIndex("by_phase_next", (q) =>
            q.eq("phase", phase).lte("nextAt", now)
          )
          .first()
      ) {
        await ctx.scheduler.runAfter(
          0,
          internal.integrityMaintenance.recover,
          {}
        )
        dispatched++
        break
      }
    }
    for (const status of ["running", "retry", "pending"]) {
      // Give a just-due scheduled action time to claim its persisted job.
      if (
        await ctx.db
          .query("jobs")
          .withIndex("by_status_next", (q) =>
            q.eq("status", status).lte("nextAt", now - 60_000)
          )
          .first()
      ) {
        await ctx.scheduler.runAfter(0, internal.jobs.recover, {})
        dispatched++
        break
      }
    }
    if (
      commerceConfigured() &&
      (await ctx.db
        .query("purchases")
        .withIndex("by_due", (q) => q.lte("nextSyncAt", now))
        .first())
    ) {
      await ctx.scheduler.runAfter(0, internal.commerceStripe.recover, {})
      dispatched++
    }
    let market = false
    for (const status of [
      "draft",
      "awaiting_approval",
      "active",
      "preparing",
      "settling",
      "committed",
      "cancelled",
      "expired",
      "failed",
    ]) {
      market ||= !!(await ctx.db
        .query("placeDeals")
        .withIndex("by_status_next", (q) =>
          q.eq("status", status).lte("nextAt", now)
        )
        .first())
    }
    for (const status of ["pending", "processing"])
      market ||= !!(await ctx.db
        .query("placePayments")
        .withIndex("by_status_next", (q) =>
          q.eq("status", status).lte("nextAt", now)
        )
        .first())
    // nextAt is the hard settlement timeout, not a heartbeat. Interrupted
    // preparation must resume before that timeout even when it is in the future.
    for (const status of ["preparing", "settling"])
      market ||= !!(await ctx.db
        .query("placeDeals")
        .withIndex("by_status_next", (q) => q.eq("status", status))
        .first())
    market ||= !!(await ctx.db
      .query("placeAccounts")
      .withIndex("by_capacity_next", (q) => q.eq("capacityVersion", undefined))
      .first())
    market ||= !!(await ctx.db
      .query("placeAccounts")
      .withIndex("by_capacity_next", (q) =>
        q.eq("capacityVersion", 0).lte("capacityNextAt", now)
      )
      .first())
    market ||= !!(await ctx.db
      .query("placeAccounts")
      .withIndex("by_frozen_reconciled", (q) =>
        q.eq("frozen", true).lte("reconciledAt", now - 3_600_000)
      )
      .first())
    if (market) {
      await ctx.scheduler.runAfter(0, internal.placeMaintenance.recover, {})
      dispatched++
    }
    console.info("maintenance.watchdog", { dispatched })
    return { dispatched }
  },
})
