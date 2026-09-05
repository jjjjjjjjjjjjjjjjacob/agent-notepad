import type { MutationCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import type { Input } from "../../lib/contracts"
import { internal } from "../_generated/api"
import {
  asId,
  enqueueTask,
  event,
  fail,
  isModerator,
  resource,
  revision,
} from "../lib/core"
import { digest } from "../../lib/hash"

export const LEASE_MS = 10 * 60_000
export async function eligible(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  task: Doc<"tasks">,
  ticket: Pick<Doc<"assignments">, "types" | "topics">
) {
  if (
    agent.blocked ||
    task.status !== "open" ||
    !ticket.types.includes(task.type)
  )
    return false
  if (ticket.topics.length && !ticket.topics.includes(task.topic)) return false
  if (
    task.creatorId === agent._id &&
    ["patrol", "edit_request", "outside_opinion"].includes(task.type)
  )
    return false
  if (task.targetId) {
    const item = await ctx.db.get(task.targetId)
    if (!item || item.suppressed) return false
    if (task.type === "edit_request") {
      if (!(await isModerator(ctx, agent, item.spaceId))) return false
      if (!task.revisionId) return false
      const pending = await ctx.db.get(task.revisionId)
      return (
        !!pending &&
        pending.status === "pending" &&
        pending.parentRevisionId === item.currentRevisionId &&
        pending.authorId !== agent._id
      )
    }
    if (task.revisionId && task.revisionId !== item.currentRevisionId)
      return false
  }
  return true
}
// A selected task always goes to its earliest eligible waiting agent. A bounded
// scan continues with a cursor instead of letting a newer ticket jump the queue.
export async function matchTask(
  ctx: MutationCtx,
  task: Doc<"tasks">,
  cursor?: string,
  firstPage?: {
    page: Doc<"assignments">[]
    isDone: boolean
    continueCursor: string
  }
) {
  if (task.status !== "open") return
  const page =
    firstPage ??
    (await ctx.db
      .query("assignments")
      .withIndex("by_status", (q) => q.eq("status", "waiting"))
      .paginate({ cursor: cursor ?? null, numItems: 64 }))
  for (const row of page.page) {
    const ticket = await ctx.db.get(row._id)
    if (
      !ticket ||
      ticket.status !== "waiting" ||
      ticket.expiresAt <= Date.now()
    )
      continue
    const agent = await ctx.db.get(ticket.agentId)
    if (!agent || !(await eligible(ctx, agent, task, ticket))) continue
    const expiresAt = Math.min(Date.now() + LEASE_MS, ticket.maxExpiresAt)
    await ctx.db.patch(task._id, {
      status: "leased",
      assignmentId: ticket._id,
      updatedAt: Date.now(),
    })
    await ctx.db.patch(ticket._id, {
      status: "active",
      taskId: task._id,
      expiresAt,
    })
    return
  }
  if (!page.isDone)
    await ctx.scheduler.runAfter(0, internal.work.matchTaskPage, {
      taskId: task._id,
      cursor: page.continueCursor,
    })
}
export async function matchPool(ctx: MutationCtx) {
  const waiting = await ctx.db
    .query("assignments")
    .withIndex("by_status", (q) => q.eq("status", "waiting"))
    .paginate({ cursor: null, numItems: 64 })
  if (!waiting.page.length) return
  const pivot = Math.random()
  const after = await ctx.db
    .query("tasks")
    .withIndex("by_status_random", (q) =>
      q.eq("status", "open").gte("random", pivot)
    )
    .take(12)
  const before =
    after.length < 12
      ? await ctx.db
          .query("tasks")
          .withIndex("by_status_random", (q) =>
            q.eq("status", "open").lt("random", pivot)
          )
          .take(12 - after.length)
      : []
  for (const task of [...after, ...before])
    await matchTask(ctx, task, undefined, waiting)
}
export async function recoverAssignment(
  ctx: MutationCtx,
  assignment: Doc<"assignments">
) {
  await ctx.db.patch(assignment._id, { status: "expired" })
  if (assignment.taskId) {
    const task = await ctx.db.get(assignment.taskId)
    if (
      task &&
      task.assignmentId === assignment._id &&
      task.status === "leased"
    )
      await ctx.db.patch(task._id, {
        status: "open",
        assignmentId: undefined,
        random: Math.random(),
        updatedAt: Date.now(),
      })
  }
}
export async function requestWork(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"request_work">
) {
  for (const status of ["active", "waiting"] as const) {
    const current = await ctx.db
      .query("assignments")
      .withIndex("by_agent_status", (q) =>
        q.eq("agentId", agent._id).eq("status", status)
      )
      .unique()
    if (current && current.expiresAt > Date.now()) return current
    if (current) await recoverAssignment(ctx, current)
  }
  const recent = await ctx.db
    .query("assignments")
    .withIndex("by_agent_status", (q) =>
      q.eq("agentId", agent._id).eq("status", "released")
    )
    .order("desc")
    .take(3)
  if (recent.length === 3 && recent[2]._creationTime > Date.now() - 5 * 60_000)
    fail(
      "RATE_LIMITED",
      "Repeatedly abandoning work triggers a five-minute cooldown.",
      { retryAfterSeconds: 300 }
    )
  const maxExpiresAt = Date.now() + input.budgetMinutes * 60_000
  const id = await ctx.db.insert("assignments", {
    agentId: agent._id,
    status: "waiting",
    ...input,
    expiresAt: maxExpiresAt,
    maxExpiresAt,
  })
  // Earlier waiting tickets receive the first opportunity; no extra ticket is created by retries.
  await matchPool(ctx)
  await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  return (await ctx.db.get(id))!
}
async function ownAssignment(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  value: string
) {
  const assignment = await ctx.db.get(asId(ctx, "assignments", value))
  if (!assignment || assignment.agentId !== agent._id)
    fail("NOT_FOUND", "Assignment not found.")
  return assignment
}
export async function renewWork(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"renew_work">
) {
  const assignment = await ownAssignment(ctx, agent, input.assignmentId)
  if (
    assignment.status !== "active" ||
    assignment.expiresAt <= Date.now() ||
    assignment.maxExpiresAt <= Date.now()
  )
    fail("CONFLICT", "This lease is no longer active.")
  const expiresAt = Math.min(Date.now() + LEASE_MS, assignment.maxExpiresAt)
  await ctx.db.patch(assignment._id, { expiresAt })
  return { assignmentId: assignment._id, expiresAt }
}
export async function releaseWork(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"release_work">
) {
  const assignment = await ownAssignment(ctx, agent, input.assignmentId)
  if (!["active", "waiting"].includes(assignment.status))
    return { assignmentId: assignment._id, status: assignment.status }
  await recoverAssignment(ctx, assignment)
  await ctx.db.patch(assignment._id, { status: "released" })
  await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  return { assignmentId: assignment._id, status: "released" }
}
export async function submitWork(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"submit_work">
) {
  const assignment = await ownAssignment(ctx, agent, input.assignmentId)
  if (assignment.status === "submitted")
    return { reportId: assignment.reportId, status: "submitted" }
  if (
    !["active", "cancelled"].includes(assignment.status) ||
    assignment.expiresAt <= Date.now() ||
    !assignment.taskId
  )
    fail("CONFLICT", "This assignment is no longer active.")
  const task = await ctx.db.get(assignment.taskId)
  if (!task || task.assignmentId !== assignment._id)
    fail("CONFLICT", "This work has been reassigned.")
  let historical = false
  if (task.targetId) {
    const item = await resource(ctx, task.targetId)
    historical = !!task.revisionId && item.currentRevisionId !== task.revisionId
    if (task.type === "edit_request") {
      const reviewed = task.revisionId
        ? await ctx.db.get(task.revisionId)
        : null
      if (
        !reviewed ||
        reviewed.reviewedBy !== agent._id ||
        !["published", "rejected"].includes(reviewed.status)
      )
        fail(
          "CONFLICT",
          "Accept or reject the pending edit before submitting its review."
        )
    } else if (
      historical ||
      ["corrected", "reverted"].includes(input.verdict)
    ) {
      if (
        !input.resultRevisionId ||
        !["corrected", "reverted"].includes(input.verdict)
      )
        fail(
          "CONFLICT",
          "This task concerns an older revision. A correction report needs the exact resulting revision."
        )
      const correction = await revision(ctx, input.resultRevisionId, item._id)
      if (
        correction.authorId !== agent._id ||
        correction.parentRevisionId !== task.revisionId ||
        correction.status !== "published" ||
        correction._creationTime < assignment._creationTime
      )
        fail(
          "CONFLICT",
          "The resulting revision must be your published correction of the assigned revision."
        )
    }
  }
  if (
    task.status !== "leased" &&
    !(task.status === "cancelled" && historical && input.resultRevisionId)
  )
    fail("CONFLICT", "This work is no longer available for submission.")
  let logFileId: Id<"files"> | undefined
  if (input.logFileId) {
    const file = await ctx.db.get(asId(ctx, "files", input.logFileId))
    if (!file || file.agentId !== agent._id || !file.ready || file.suppressed)
      fail("FORBIDDEN", "The review log must be one of your completed uploads.")
    logFileId = file._id
  }
  const result = input.resultResourceId
    ? await resource(ctx, input.resultResourceId)
    : undefined
  if (
    ["knowledge_gap", "citation", "maintenance"].includes(task.type) &&
    !result
  )
    fail("VALIDATION", "This task requires a resulting contribution.")
  if (task.targetId && result && result._id !== task.targetId)
    fail("VALIDATION", "The result must concern this task's contribution.")
  const reportTargetId = task.targetId ?? result?._id
  const reportRevisionId = task.revisionId ?? result?.currentRevisionId
  const reportId = await ctx.db.insert("reports", {
    taskId: task._id,
    assignmentId: assignment._id,
    agentId: agent._id,
    ...(reportTargetId ? { targetId: reportTargetId } : {}),
    ...(reportRevisionId ? { revisionId: reportRevisionId } : {}),
    report: input.report,
    verdict: input.verdict,
    evidence: input.evidence,
    ...(input.log ? { log: input.log } : {}),
    ...(logFileId ? { logFileId } : {}),
    ...(result ? { resultResourceId: result._id } : {}),
    historical,
    suppressed: false,
  })
  await ctx.db.patch(assignment._id, { status: "submitted", reportId })
  await ctx.db.patch(task._id, {
    status: "completed",
    issueOpen: input.verdict === "issue" || input.verdict === "discussion",
    updatedAt: Date.now(),
  })
  await ctx.db.patch(agent._id, { reviewCount: agent.reviewCount + 1 })
  if (!historical && input.verdict === "issue" && task.targetId) {
    await ctx.db.patch(task.targetId, { disputed: true })
    await enqueueTask(ctx, {
      type: "outside_opinion",
      topic: task.topic,
      title: `Outside opinion: ${task.title}`,
      description: input.report.slice(0, 4000),
      targetId: task.targetId,
      ...(task.revisionId ? { revisionId: task.revisionId } : {}),
      creatorId: agent._id,
      dedupeKey: `opinion:${task.targetId}:${task.revisionId ?? "general"}`,
    })
  }
  if (
    !historical &&
    task.type === "outside_opinion" &&
    task.targetId &&
    input.verdict === "checked"
  ) {
    const unresolved = await ctx.db
      .query("tasks")
      .withIndex("by_target", (q) => q.eq("targetId", task.targetId))
      .filter((q) =>
        q.and(
          q.eq(q.field("type"), "outside_opinion"),
          q.eq(q.field("issueOpen"), true),
          q.neq(q.field("status"), "cancelled")
        )
      )
      .first()
    if (!unresolved) await ctx.db.patch(task.targetId, { disputed: false })
  }
  await ctx.scheduler.runAfter(0, internal.work.matchWaiting, {})
  await event(ctx, {
    kind: "patrol",
    targetId: reportTargetId ?? task._id,
    actorId: agent._id,
    title: task.title,
    ...(reportRevisionId ? { revisionId: reportRevisionId } : {}),
  })
  return {
    reportId,
    status: "submitted",
    note: "Submission records the work and releases the lease. It does not certify correctness or promise payment.",
  }
}
export async function raiseIssue(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  input: Input<"raise_issue">
) {
  const item = input.resourceId
    ? await resource(ctx, input.resourceId)
    : undefined
  const rev =
    input.revisionId && item
      ? await revision(ctx, input.revisionId, item._id)
      : undefined
  if (input.revisionId && !item)
    fail("VALIDATION", "A revision requires its parent contribution.")
  const taskId = await enqueueTask(ctx, {
    type: input.type,
    topic: item?.topic ?? input.topic,
    title: item
      ? `${input.type.replaceAll("_", " ")}: ${item.title}`
      : input.description.slice(0, 100),
    description: input.description,
    ...(item ? { targetId: item._id } : {}),
    ...(rev ? { revisionId: rev._id } : {}),
    creatorId: agent._id,
    dedupeKey: `${input.type}:${item?._id ?? "global"}:${rev?._id ?? "current"}:${digest(input.description.toLowerCase().trim())}`,
  })
  if (item && input.type === "outside_opinion")
    await ctx.db.patch(item._id, { disputed: true })
  return { taskId }
}
