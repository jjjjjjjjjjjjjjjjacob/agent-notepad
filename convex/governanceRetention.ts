import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import type { MutationCtx } from "./_generated/server"
import { internal } from "./_generated/api"
import { metric } from "./lib/core"
import type { Doc } from "./_generated/dataModel"
import { DAY } from "../lib/moderation-policy"

const lease = 60_000
export async function startRetention(
  ctx: MutationCtx,
  name: "network" | "evidence"
) {
  let job = await ctx.db
    .query("governanceRetentionJobs")
    .withIndex("by_name", (q) => q.eq("name", name))
    .unique()
  if (job?.running && job.nextAt > Date.now()) return
  if (!job?.running) {
    const fields = {
      name,
      generation: (job?.generation ?? 0) + 1,
      step: 0,
      phase: 0,
      cutoff: Date.now(),
      running: true,
      nextAt: Date.now() + lease,
      pages: 0,
      deleted: 0,
      lastBatchSize: 0,
      cursor: undefined,
      caseId: undefined,
      caseCursor: undefined,
      outerDone: undefined,
    }
    if (job) await ctx.db.patch(job._id, fields)
    else {
      const id = await ctx.db.insert("governanceRetentionJobs", fields)
      job = await ctx.db.get(id)
    }
    job = (await ctx.db.get(job!._id))!
  } else await ctx.db.patch(job._id, { nextAt: Date.now() + lease })
  const args = { generation: job!.generation, step: job!.step }
  if (name === "network")
    await ctx.scheduler.runAfter(
      0,
      internal.governanceRetention.networkPage,
      args
    )
  else
    await ctx.scheduler.runAfter(0, internal.governance.retireEvidence, {
      ...args,
      ...(job!.cursor ? { cursor: job!.cursor } : {}),
    })
}

export const networkPage = internalMutation({
  args: { generation: v.number(), step: v.number() },
  handler: async (ctx, args) => {
    const job = await ctx.db
      .query("governanceRetentionJobs")
      .withIndex("by_name", (q) => q.eq("name", "network"))
      .unique()
    if (
      !job?.running ||
      job.generation !== args.generation ||
      job.step !== args.step
    )
      return
    const table = [
      "networkObservations",
      "gatewayNonces",
      "appealLinkTokens",
    ] as const
    const rows = await ctx.db
      .query(table[job.phase])
      .withIndex("by_expiry", (q) => q.lte("expiresAt", job.cutoff))
      .take(100)
    for (const row of rows) await ctx.db.delete(row._id)
    const phase = job.phase + (rows.length < 100 ? 1 : 0)
    const running = phase < table.length
    await ctx.db.patch(job._id, {
      phase,
      running,
      step: job.step + 1,
      nextAt: running ? Date.now() + lease : 0,
      pages: job.pages + 1,
      deleted: job.deleted + rows.length,
      lastBatchSize: rows.length,
    })
    await metric(ctx, "retention.network_page")
    if (rows.length === 100) await metric(ctx, "retention.network_backlog_page")
    if (running)
      await ctx.scheduler.runAfter(
        0,
        internal.governanceRetention.networkPage,
        { generation: job.generation, step: job.step + 1 }
      )
  },
})

async function canRetire(
  ctx: MutationCtx,
  c: Doc<"moderationCases">,
  cutoff: number
) {
  if (
    c.state !== "resolved" ||
    c.resolvedAt === undefined ||
    c.resolvedAt > cutoff - 90 * DAY
  )
    return false
  // Index existence checks cover every child without loading its evidence or
  // collecting an unbounded case family. Missing resolution times stay private.
  for (const state of ["queued", "seating", "voting", "escalated"] as const)
    if (
      await ctx.db
        .query("moderationCases")
        .withIndex("by_parent_state_resolved", (q) =>
          q.eq("parentCaseId", c._id).eq("state", state)
        )
        .first()
    )
      return false
  if (
    await ctx.db
      .query("moderationCases")
      .withIndex("by_parent_state_resolved", (q) =>
        q
          .eq("parentCaseId", c._id)
          .eq("state", "resolved")
          .eq("resolvedAt", undefined)
      )
      .first()
  )
    return false
  return !(await ctx.db
    .query("moderationCases")
    .withIndex("by_parent_state_resolved", (q) =>
      q
        .eq("parentCaseId", c._id)
        .eq("state", "resolved")
        .gt("resolvedAt", cutoff - 90 * DAY)
    )
    .first())
}
export async function retireEvidencePage(
  ctx: MutationCtx,
  generation: number,
  step: number
) {
  const job = await ctx.db
    .query("governanceRetentionJobs")
    .withIndex("by_name", (q) => q.eq("name", "evidence"))
    .unique()
  if (!job?.running || job.generation !== generation || job.step !== step)
    return
  let changes: Partial<Doc<"governanceRetentionJobs">> = {}
  if (!job.caseId) {
    const page = await ctx.db
      .query("moderationCases")
      .withIndex("by_state", (q) => q.eq("state", "resolved"))
      .paginate({
        cursor: job.cursor ?? null,
        numItems: 1,
        maximumBytesRead: 1_000_000,
      })
    const c = page.page[0]
    changes = {
      cursor: page.isDone ? undefined : page.continueCursor,
      outerDone: page.isDone,
      running: !page.isDone,
      lastBatchSize: page.page.length,
    }
    if (c && !c.evidencePurgedAt && (await canRetire(ctx, c, job.cutoff))) {
      await ctx.db.patch(c._id, { evidenceRetiringAt: Date.now() })
      changes = {
        ...changes,
        caseId: c._id,
        phase: 1,
        caseCursor: undefined,
        running: true,
      }
    }
  } else {
    const c = await ctx.db.get(job.caseId)
    const done = {
      caseId: undefined,
      caseCursor: undefined,
      phase: 0,
      running: !job.outerDone,
    }
    if (!c || !(await canRetire(ctx, c, job.cutoff))) {
      if (c) await ctx.db.patch(c._id, { evidenceRetiringAt: undefined })
      changes = done
    } else if (job.phase === 1) {
      // A document is at most 1 MiB. Two documents, including delete reads,
      // plus the bounded eligibility lookups leave ample transaction headroom.
      const rows = await ctx.db
        .query("moderationEvidence")
        .withIndex("by_case", (q) => q.eq("caseId", c._id))
        .take(2)
      for (const row of rows) await ctx.db.delete(row._id)
      changes = {
        phase: rows.length < 2 ? 2 : 1,
        deleted: job.deleted + rows.length,
        lastBatchSize: rows.length,
      }
      if (rows.length < 2)
        await ctx.db.patch(c._id, {
          ipHash: undefined,
          evidencePurgedAt: Date.now(),
        })
    } else {
      const page = await ctx.db
        .query("sanctions")
        .withIndex("by_case_expiry", (q) =>
          q
            .eq("caseId", c._id)
            .gt("expiresAt", undefined)
            .lte("expiresAt", job.cutoff)
        )
        .paginate({
          cursor: job.caseCursor ?? null,
          numItems: 100,
          maximumBytesRead: 1_000_000,
        })
      let deleted = 0
      for (const row of page.page)
        if (row.principal.startsWith("ip:")) {
          await ctx.db.delete(row._id)
          deleted++
        }
      changes = {
        caseCursor: page.continueCursor,
        deleted: job.deleted + deleted,
        lastBatchSize: page.page.length,
      }
      if (page.isDone) {
        await ctx.db.patch(c._id, { evidenceRetiringAt: undefined })
        changes = { ...changes, ...done }
      }
    }
  }
  const running = changes.running ?? true
  await ctx.db.patch(job._id, {
    ...changes,
    step: step + 1,
    pages: job.pages + 1,
    nextAt: running ? Date.now() + lease : 0,
  })
  await metric(ctx, "retention.evidence_page")
  if (running)
    await ctx.scheduler.runAfter(0, internal.governance.retireEvidence, {
      generation,
      step: step + 1,
    })
}
