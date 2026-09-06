import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { internal } from "../_generated/api"
import { DAY } from "../../lib/moderation-policy"
import { hasHold, audit } from "./access"

export async function addSanction(
  ctx: MutationCtx,
  caseId: Id<"moderationCases">,
  principal: string,
  provisional: boolean,
  expiresAt?: number
) {
  const existing = await ctx.db
    .query("sanctions")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .filter((q) =>
      q.and(
        q.eq(q.field("principal"), principal),
        q.eq(q.field("provisional"), provisional)
      )
    )
    .first()
  if (!existing)
    await ctx.db.insert("sanctions", {
      caseId,
      principal,
      provisional,
      ...(expiresAt ? { expiresAt } : {}),
    })
}
export async function cancelAgentWork(ctx: MutationCtx, agentId: Id<"agents">) {
  for (const status of ["waiting", "active"] as const) {
    const rows = await ctx.db
      .query("assignments")
      .withIndex("by_agent_status", (q) =>
        q.eq("agentId", agentId).eq("status", status)
      )
      .collect()
    for (const row of rows) {
      await ctx.db.patch(row._id, { status: "cancelled" })
      if (row.taskId) {
        const task = await ctx.db.get(row.taskId)
        if (task && !task.committeeCaseId && task.assignmentId === row._id)
          await ctx.db.patch(task._id, {
            status: "open",
            assignmentId: undefined,
            updatedAt: Date.now(),
          })
      }
    }
  }
}
async function heldRecord(ctx: MutationCtx, targetId: string) {
  for (const table of [
    "resources",
    "revisions",
    "comments",
    "spaces",
    "files",
    "agents",
    "reports",
    "events",
  ] as const) {
    const id = ctx.db.normalizeId(table, targetId)
    if (id) return await ctx.db.get(id)
  }
  return null
}
export async function setHold(
  ctx: MutationCtx,
  caseId: Id<"moderationCases">,
  targetId: string
) {
  const existing = await ctx.db
    .query("contentHolds")
    .withIndex("by_case", (q) => q.eq("caseId", caseId))
    .filter((q) => q.eq(q.field("targetId"), targetId))
    .first()
  if (!existing) await ctx.db.insert("contentHolds", { caseId, targetId })
  const row = await heldRecord(ctx, targetId)
  if (row) {
    await ctx.db.patch(row._id, { quarantined: true })
    if ("contentType" in row)
      await ctx.scheduler.runAfter(0, internal.moderationFiles.privatize, {
        fileId: row._id,
      })
  }
}
export async function quarantineCase(
  ctx: MutationCtx,
  c: Doc<"moderationCases">
) {
  if (c.reason !== "prompt_injection") return
  await setHold(ctx, c._id, c.targetId)
  if (c.revisionId) {
    await setHold(ctx, c._id, c.revisionId)
    const rev = await ctx.db.get(c.revisionId)
    const resource = rev ? await ctx.db.get(rev.resourceId) : null
    if (resource?.currentRevisionId === c.revisionId)
      await setHold(ctx, c._id, resource._id)
    for (const fileId of rev?.attachmentIds ?? [])
      await setHold(ctx, c._id, fileId)
  }
  if (c.resourceId) {
    const docs = await ctx.db
      .query("searchDocuments")
      .withIndex("by_resource", (q) => q.eq("resourceId", c.resourceId!))
      .collect()
    for (const doc of docs)
      if (!c.revisionId || doc.revisionId === c.revisionId)
        await ctx.db.delete(doc._id)
  }
}
export async function impose(
  ctx: MutationCtx,
  c: Doc<"moderationCases">,
  provisional: boolean
) {
  await addSanction(
    ctx,
    c._id,
    `agent:${c.subjectId}`,
    provisional,
    provisional ? Date.now() + DAY : undefined
  )
  if (!provisional && c.subjectOwnerId)
    await addSanction(ctx, c._id, `owner:${c.subjectOwnerId}`, false)
  if (c.ipHash)
    await addSanction(
      ctx,
      c._id,
      `ip:${c.ipHash}`,
      provisional,
      Date.now() + (provisional ? 1 : 30) * DAY
    )
  await cancelAgentWork(ctx, c.subjectId)
  if (!provisional && c.subjectOwnerId)
    await ctx.scheduler.runAfter(0, internal.governance.cancelOwnerWork, {
      ownerId: c.subjectOwnerId,
    })
  await quarantineCase(ctx, c)
}
export async function liftCase(ctx: MutationCtx, c: Doc<"moderationCases">) {
  for (const sanction of await ctx.db
    .query("sanctions")
    .withIndex("by_case", (q) => q.eq("caseId", c._id))
    .collect())
    if (!sanction.liftedAt)
      await ctx.db.patch(sanction._id, { liftedAt: Date.now() })
  for (const hold of await ctx.db
    .query("contentHolds")
    .withIndex("by_case", (q) => q.eq("caseId", c._id))
    .collect()) {
    if (!hold.liftedAt) await ctx.db.patch(hold._id, { liftedAt: Date.now() })
    const row = await heldRecord(ctx, hold.targetId)
    if (row && !(await hasHold(ctx, hold.targetId)))
      await ctx.db.patch(row._id, {
        quarantined: false,
        ...("scanStatus" in row && row.scanStatus === "quarantined"
          ? { scanStatus: "clear" as const }
          : {}),
      })
  }
  if (c.resourceId)
    await ctx.scheduler.runAfter(0, internal.governance.reindex, {
      resourceId: c.resourceId,
    })
  await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  await audit(
    ctx,
    "system",
    "lift_case",
    c._id,
    "Removed only restrictions belonging to this decision."
  )
}
