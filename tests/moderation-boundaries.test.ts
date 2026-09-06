/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, internal, components } from "../convex/_generated/api"
import type { Doc, Id } from "../convex/_generated/dataModel"
import { commandSchemas, ordinaryScopes } from "../lib/contracts"
import { digest, stableJson } from "../lib/hash"
import { createCase, reportAbuse, openAppeal } from "../convex/moderation/cases"
import { caseView } from "../convex/moderation/reads"
import { liftCase, setHold } from "../convex/moderation/sanctions"
import { eligible } from "../convex/ops/tasks"
import { flagInjection } from "../convex/integrity/operations"
import { enqueueTask } from "../convex/lib/core"
import { taskVisible } from "../convex/moderation/taskVisibility"
import { syncWikiGraph } from "../convex/lib/wikiGraph"
import { decide } from "../convex/moderation/decisions"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = (transactionLimits = false) => {
  const t = convexTest({ schema, modules, transactionLimits })
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
const marker = "WITHHELD_REPORT_BOUNDARY_MARKER"
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("MODERATION_ENABLED", "true")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
async function actor(t: Test, ownerId?: string) {
  const token = crypto.randomUUID()
  const agent = await t.run(async ctx => {
    const id = await ctx.db.insert("agents", {
      name: "Fixture", slug: `fixture-${crypto.randomUUID()}`, bio: "",
      capabilities: [], topics: [], role: "editor", blocked: false,
      contributionCount: 0, reviewCount: 0, updatedAt: Date.now(),
      ...(ownerId ? { ownerId } : {}),
    })
    await ctx.db.insert("keys", {
      agentId: id, hash: digest(token), prefix: "fixture", label: "Fixture",
      scopes: [...ordinaryScopes],
    })
    return (await ctx.db.get(id))!
  })
  return { agent, token }
}
async function fixture(t: Test) {
  const author = await actor(t, "fixture-subject-owner")
  const reviewer = await actor(t, "fixture-reporter-owner")
  const resource = await t.run(async ctx => {
    const id = await ctx.db.insert("resources", {
      kind: "wiki", slug: `fixture-${crypto.randomUUID()}`, title: "Safe article",
      excerpt: "Safe excerpt", authorId: author.agent._id, topic: "fixture",
      score: 0, commentCount: 0, disputed: false, suppressed: false,
      protection: "open", updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id, authorId: author.agent._id, title: "Safe article",
      body: "HIDDEN_TARGET_BOUNDARY_MARKER", summary: "Safe summary",
      citations: [], attachmentIds: [], status: "published", suppressed: false,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    const taskId = await ctx.db.insert("tasks", {
      type: "patrol", topic: "fixture", title: "Safe patrol", description: "Safe task",
      targetId: id, revisionId, sourceRevisionId: revisionId, creatorId: author.agent._id, dedupeKey: `patrol:${revisionId}`,
      status: "leased", issueOpen: false, random: 0.5, updatedAt: Date.now(),
    })
    const assignmentId = await ctx.db.insert("assignments", {
      agentId: reviewer.agent._id, taskId, status: "active", types: ["patrol"], topics: [],
      budgetMinutes: 10, expiresAt: Date.now() + 600000, maxExpiresAt: Date.now() + 600000,
    })
    await ctx.db.patch(taskId, { assignmentId })
    return { id, revisionId, taskId, assignmentId }
  })
  return { author, reviewer, ...resource }
}
async function submit(t: Test, f: Awaited<ReturnType<typeof fixture>>, quarantine = false, verdict: "issue" | "checked" = "issue") {
  const input = commandSchemas.submit_work.parse({
    assignmentId: f.assignmentId, verdict, report: marker, log: "Safe fixture log",
  })
  const fingerprint = digest(stableJson({ operation: "submit_work", input }))
  const scan = quarantine ? await t.mutation(internal.screeningResults.flag, {
    agentId: f.reviewer.agent._id, fingerprint, content: stableJson(input), operation: "submit_work",
    confidence: "HIGH", evidenceOnly: true, assessment: "Synthetic fixture classification",
  }) : null
  const result = await t.mutation(internal.commands.execute, {
    token: f.reviewer.token, operation: "submit_work", input, screeningFingerprint: fingerprint,
    ...(scan ? { quarantineCaseId: scan.caseId } : {}),
  }) as { reportId: Id<"reports"> }
  const task = await t.run(ctx => ctx.db.query("tasks").filter(q => q.eq(q.field("type"), "outside_opinion")).first())
  return { ...result, task: task!, caseId: scan?.caseId }
}
async function hold(t: Test, subject: Doc<"agents">, targetId: string) {
  return t.run(async ctx => {
    const id = await createCase(ctx, {
      kind: "conduct", reason: "prompt_injection", targetKind: "report", targetId,
      subjectId: subject._id, dedupeKey: crypto.randomUUID(), evidence: "Safe evidence", provenance: "Fixture",
    })
    await setHold(ctx, id, targetId)
    return id
  })
}
async function lift(t: Test, id: Id<"moderationCases">) {
  await t.run(async ctx => liftCase(ctx, (await ctx.db.get(id))!))
}
async function human(t: Test) {
  const user = await t.mutation(components.betterAuth.adapter.create, { input: {
    model: "user", data: { name: "Fixture human", email: `${crypto.randomUUID()}@example.test`,
      emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() },
  } })
  const session = await t.mutation(components.betterAuth.adapter.create, { input: {
    model: "session", data: { userId: user._id, token: crypto.randomUUID(), expiresAt: Date.now() + 600000,
      createdAt: Date.now(), updatedAt: Date.now() },
  } })
  return { id: user._id, client: t.withIdentity({ subject: user._id, sessionId: session._id }) }
}

describe("derived task moderation boundaries", () => {
  it("preserves restricted committee and integrity tasks during legacy retirement", async () => {
    const t = setup(), f = await fixture(t)
    const { reviewId } = await t.run(ctx => flagInjection(ctx, { resourceId: f.id, agentId: f.author.agent._id, reason: "Harmless restricted fixture" }, {}))
    const taskId = await t.run(async ctx => {
      const caseId = await createCase(ctx, { kind: "admission", reason: "spam", targetKind: "agent", targetId: f.author.agent._id,
        subjectId: f.author.agent._id, dedupeKey: "legacy-committee", evidence: "Safe restricted evidence", provenance: "Fixture" })
      await ctx.db.patch(f.taskId, { type: "committee_review", committeeCaseId: caseId, sourceRevisionId: undefined })
      return (await ctx.db.get(reviewId))!.taskId!
    })
    const before = await t.run(ctx => ctx.db.get(taskId))
    await t.mutation(internal.work.retireLegacyTaskCopies, {})
    expect(await t.run(ctx => ctx.db.get(taskId))).toEqual(before)
    expect(await t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ description: "Safe task", status: "leased" })
  })

  it.each(["absent", "historical"])("withholds ambiguous legacy issue titles with %s assigned revision", async mode => {
    const t = setup(), f = await fixture(t)
    await t.run(async ctx => {
      const historicalId = await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.author.agent._id,
        title: "Earlier safe title", body: "Safe fixture", summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false })
      const currentId = await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.author.agent._id,
        title: "Current safe title", body: "Safe fixture", summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false })
      await ctx.db.patch(f.id, { currentRevisionId: currentId })
      await ctx.db.patch(f.taskId, { type: "maintenance", title: "WITHHELD_LEGACY_ISSUE_TITLE", dedupeKey: "issue:legacy",
        revisionId: mode === "historical" ? historicalId : undefined, sourceRevisionId: undefined })
      await ctx.db.patch(f.revisionId, { title: "WITHHELD_LEGACY_ISSUE_TITLE", quarantined: true })
    })
    expect(await t.query(api.public.getTask, { id: f.taskId })).toBeNull()
    await t.mutation(internal.work.retireLegacyTaskCopies, {})
    expect(await t.run(ctx => ctx.db.get(f.taskId))).toMatchObject({ description: "", status: "cancelled" })
  })

  it("retains the revision attribution of titles copied through a report task", async () => {
    const t = setup(), f = await fixture(t)
    const sourceId = await t.run(async ctx => {
      const id = await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.author.agent._id,
        title: "WITHHELD_COPIED_TITLE", body: "Safe fixture", summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false })
      await ctx.db.patch(f.taskId, { title: "Review WITHHELD_COPIED_TITLE", sourceRevisionId: id })
      return id
    })
    const result = await submit(t, f)
    expect(JSON.stringify(await t.query(api.public.getTask, { id: result.task._id }))).toContain("WITHHELD_COPIED_TITLE")
    await t.run(ctx => ctx.db.patch(sourceId, { quarantined: true }))
    expect(await t.query(api.public.getTask, { id: result.task._id })).toBeNull()
  })

  it("does not let a quarantined report resolve a public dispute", async () => {
    const t = setup(), f = await fixture(t)
    await t.run(async ctx => {
      await ctx.db.patch(f.id, { disputed: true })
      await ctx.db.patch(f.taskId, { type: "outside_opinion", issueOpen: true })
    })
    await submit(t, f, true, "checked")
    expect((await t.run(ctx => ctx.db.get(f.id)))?.disputed).toBe(true)
    expect((await t.run(ctx => ctx.db.get(f.taskId)))?.issueOpen).toBe(true)
  })

  it("never publishes initially quarantined report text through tasks or matching", async () => {
    const t = setup(), f = await fixture(t), result = await submit(t, f, true)
    expect(await t.query(api.public.getReport, { id: result.reportId })).toBeNull()
    const tasks = await t.query(api.public.tasks, { paginationOpts: { cursor: null, numItems: 50 } })
    expect(JSON.stringify(tasks)).not.toContain(marker)
    expect(await t.query(api.public.getTask, { id: result.task._id })).toBeNull()
    expect(await t.run(ctx => eligible(ctx, f.author.agent, result.task, { types: ["outside_opinion"], topics: [] }))).toBe(false)
    expect((await t.run(ctx => ctx.db.get(f.id)))?.disputed).toBe(false)
    await lift(t, result.caseId!)
    expect(await t.query(api.public.getTask, { id: result.task._id })).toMatchObject({ description: marker })
  })

  it("withdraws an existing derivative and lease immediately; only the last hold restores them", async () => {
    const t = setup(), f = await fixture(t), result = await submit(t, f)
    const worker = await actor(t)
    const assignmentId = await t.run(async ctx => {
      const id = await ctx.db.insert("assignments", {
        agentId: worker.agent._id, taskId: result.task._id, status: "active", types: ["outside_opinion"], topics: [],
        budgetMinutes: 10, expiresAt: Date.now() + 600000, maxExpiresAt: Date.now() + 600000,
      })
      await ctx.db.patch(result.task._id, { status: "leased", assignmentId: id })
      return id
    })
    expect(await t.query(api.public.getTask, { id: result.task._id })).toMatchObject({ description: marker })
    const first = await hold(t, f.reviewer.agent, result.reportId)
    const second = await hold(t, f.reviewer.agent, result.reportId)
    expect(await t.query(api.public.getTask, { id: result.task._id })).toBeNull()
    expect(JSON.stringify(await t.query(internal.personal.work, { token: worker.token }))).not.toContain(marker)
    await expect(t.mutation(internal.commands.execute, {
      token: worker.token, operation: "renew_work", input: { assignmentId },
    })).rejects.toThrow("unavailable")
    const input = commandSchemas.submit_work.parse({ assignmentId, report: "A safe follow-up report that must not be accepted.", verdict: "checked", log: "Safe log" })
    await expect(t.mutation(internal.commands.execute, {
      token: worker.token, operation: "submit_work", input,
      screeningFingerprint: digest(stableJson({ operation: "submit_work", input })),
    })).rejects.toThrow("unavailable")
    await lift(t, first)
    expect(await t.query(api.public.getTask, { id: result.task._id })).toBeNull()
    await lift(t, second)
    expect(await t.query(api.public.getTask, { id: result.task._id })).toMatchObject({ description: marker })
  })

  it("fails closed for legacy opinion copies without provenance", async () => {
    const t = setup(), f = await fixture(t)
    const id = await t.run(ctx => ctx.db.insert("tasks", {
      type: "outside_opinion", topic: "fixture", title: "Old opinion", description: marker,
      targetId: f.id, revisionId: f.revisionId, creatorId: f.reviewer.agent._id,
      dedupeKey: `opinion:${f.id}:${f.revisionId}`, status: "open", issueOpen: true, random: 0.5, updatedAt: Date.now(),
    }))
    expect(await t.query(api.public.getTask, { id })).toBeNull()
  })

  it.each(["missing", "suppressed", "stale text", "wrong source", "hidden community"])("withholds a derivative with %s source state", async state => {
    const t = setup(), f = await fixture(t), result = await submit(t, f)
    await t.run(async ctx => {
      if (state === "missing") await ctx.db.delete(result.reportId)
      if (state === "suppressed") await ctx.db.patch(result.reportId, { suppressed: true })
      if (state === "stale text") await ctx.db.patch(result.task._id, { description: "UNRELATED_STALE_TEXT_MARKER" })
      if (state === "wrong source") await ctx.db.patch(result.reportId, { agentId: f.author.agent._id })
      if (state === "hidden community") {
        const parent = await ctx.db.insert("spaces", { kind: "community", name: "Hidden", slug: "hidden", description: "", ownerId: f.author.agent._id, suppressed: false, quarantined: true, updatedAt: Date.now() })
        const channel = await ctx.db.insert("spaces", { kind: "channel", name: "General", slug: "hidden-general", description: "", ownerId: f.author.agent._id, parentId: parent, suppressed: false, updatedAt: Date.now() })
        await ctx.db.patch(f.id, { spaceId: channel })
      }
    })
    const task = (await t.run(ctx => ctx.db.get(result.task._id)))!
    expect(await t.query(api.public.getTask, { id: task._id })).toBeNull()
    expect(await t.run(ctx => eligible(ctx, f.author.agent, task, { types: ["outside_opinion"], topics: [] }))).toBe(false)
  })

  it("retires legacy copied text and leases in bounded resumable pages", async () => {
    const t = setup(), f = await fixture(t)
    const ids = await t.run(async ctx => {
      const rows = []
      for (let n = 0; n < 52; n++) rows.push(await ctx.db.insert("tasks", {
        type: "outside_opinion", topic: "fixture", title: marker, description: marker,
        targetId: f.id, creatorId: f.reviewer.agent._id, dedupeKey: `opinion:legacy-${n}`,
        status: n ? "open" : "leased", issueOpen: true, random: 0.5, updatedAt: Date.now(),
        ...(!n ? { assignmentId: f.assignmentId } : {}),
      }))
      await ctx.db.patch(f.assignmentId, { taskId: rows[0] })
      return rows
    })
    const first = await t.mutation(internal.work.retireLegacyTaskCopies, {})
    expect(first.complete).toBe(false)
    expect(await t.mutation(internal.work.retireLegacyTaskCopies, { cursor: first.cursor! })).toMatchObject({ complete: true })
    for (const id of ids) expect(await t.run(ctx => ctx.db.get(id))).toMatchObject({ description: "", status: "cancelled" })
    expect(await t.run(ctx => ctx.db.get(f.assignmentId))).toMatchObject({ status: "cancelled" })
  })

  it("keeps quarantined submission retries idempotent and rejects mismatched report dedupe", async () => {
    const t = setup(), f = await fixture(t)
    const input = commandSchemas.submit_work.parse({ assignmentId: f.assignmentId, verdict: "issue", report: marker, log: "Safe log" })
    const fingerprint = digest(stableJson({ operation: "submit_work", input }))
    const scan = await t.mutation(internal.screeningResults.flag, {
      agentId: f.reviewer.agent._id, fingerprint, content: stableJson(input), operation: "submit_work",
      confidence: "HIGH", evidenceOnly: true, assessment: "Fixture",
    })
    const args = { token: f.reviewer.token, operation: "submit_work", input, screeningFingerprint: fingerprint, quarantineCaseId: scan.caseId, idempotencyKey: "quarantined-retry" }
    const first = await t.mutation(internal.commands.execute, args)
    expect(await t.mutation(internal.commands.execute, args)).toEqual(first)
    const task = (await t.run(ctx => ctx.db.query("tasks").filter(q => q.eq(q.field("type"), "outside_opinion")).first()))!
    expect(await t.run(ctx => enqueueTask(ctx, {
      type: task.type, topic: task.topic, title: task.title, description: task.description,
      targetId: task.targetId, revisionId: task.revisionId, creatorId: task.creatorId,
      sourceReportId: task.sourceReportId, sourceRevisionId: task.sourceRevisionId, dedupeKey: task.dedupeKey,
    }))).toBe(task._id)
    expect((await t.run(ctx => ctx.db.get(task._id)))?.sourceReportId).toBe(task.sourceReportId)
    const different = await t.run(async ctx => {
      const source = (await ctx.db.get(task.sourceReportId!))!
      const { _id, _creationTime, ...fields } = source
      void _id; void _creationTime
      return ctx.db.insert("reports", fields)
    })
    await expect(t.run(ctx => enqueueTask(ctx, { type: task.type, topic: task.topic, title: "Unrelated", description: "Unrelated", dedupeKey: task.dedupeKey, sourceReportId: different }))).rejects.toThrow("different source report")
    expect(await t.query(api.public.getTask, { id: task._id })).toBeNull()
  })

  it("withholds link-derived tasks after a real integrity fallback and safely replaces withdrawn gap sources", async () => {
    const t = setup(), f = await fixture(t)
    await t.run(async ctx => {
      await ctx.db.patch(f.revisionId, { body: "[Safe gap](/wiki/safe-gap)" })
      await syncWikiGraph(ctx, (await ctx.db.get(f.id))!, (await ctx.db.get(f.revisionId))!)
    })
    const badRevision = await t.run(async ctx => {
      const id = await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.reviewer.agent._id,
        parentRevisionId: f.revisionId, title: "Article", body: "[WITHHELD_LINK_MARKER](/wiki/withheld-gap)",
        summary: "WITHHELD_SUMMARY_MARKER", citations: [], attachmentIds: [], status: "published", suppressed: false })
      await ctx.db.patch(f.id, { currentRevisionId: id })
      await syncWikiGraph(ctx, (await ctx.db.get(f.id))!, (await ctx.db.get(id))!)
      return id
    })
    const gap = (await t.run(ctx => ctx.db.query("tasks").withIndex("by_dedupe", q => q.eq("dedupeKey", "wiki-gap:withheld-gap")).unique()))!
    expect(gap.sourceRevisionId).toBe(badRevision)
    await t.run(ctx => flagInjection(ctx, { resourceId: f.id, agentId: f.reviewer.agent._id, reason: "Safe fixture integrity decision." }, {}))
    expect(await t.query(api.public.getTask, { id: gap._id })).toBeNull()
    expect(await t.run(ctx => taskVisible(ctx, gap))).toBe(false)
    expect(JSON.stringify(await t.query(api.public.tasks, { paginationOpts: { cursor: null, numItems: 50 } }))).not.toContain("WITHHELD_LINK_MARKER")
    const safe = await t.run(async ctx => {
      await ctx.db.patch(f.revisionId, { body: "[Safe restored gap](/wiki/withheld-gap)" })
      await syncWikiGraph(ctx, (await ctx.db.get(f.id))!, (await ctx.db.get(f.revisionId))!)
      return ctx.db.get(gap._id)
    })
    expect(safe).toMatchObject({ sourceRevisionId: f.revisionId, title: "Write Safe restored gap" })
    expect(await t.query(api.public.getTask, { id: gap._id })).toMatchObject({ title: "Write Safe restored gap" })
  })

  it("preserves legitimate pending-edit tasks but withdraws a held pending revision", async () => {
    const t = setup(), f = await fixture(t)
    const id = await t.run(async ctx => {
      const revisionId = await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.reviewer.agent._id,
        parentRevisionId: f.revisionId, title: "Pending", body: "Safe proposal", summary: "Safe summary",
        citations: [], attachmentIds: [], status: "pending", suppressed: false })
      return enqueueTask(ctx, { type: "edit_request", topic: "fixture", title: "Review pending edit", description: "Safe summary",
        targetId: f.id, revisionId, creatorId: f.reviewer.agent._id, dedupeKey: `pending:${revisionId}` })
    })
    expect(await t.query(api.public.getTask, { id })).not.toBeNull()
    const task = (await t.run(ctx => ctx.db.get(id)))!
    await t.run(ctx => ctx.db.patch(task.revisionId!, { quarantined: true }))
    expect(await t.query(api.public.getTask, { id })).toBeNull()
  })
})

describe("report intake is not evidence authorization", () => {
  it("preserves large valid Unicode evidence unchanged through admission, conduct and appeal", async () => {
    const t = setup(true), f = await fixture(t)
    const input = commandSchemas.publish.parse({
      kind: "wiki", title: "Large evidence fixture",
      body: "文".repeat(90000) + "x".repeat(10000),
      citations: Array.from({ length: 30 }, (_, n) => ({
        url: `https://example.test/source/${n}`, title: "Fixture citation",
        quote: "文".repeat(2500) + '\"\\'.repeat(750),
      })),
    })
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(590000)
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(600000)
    await t.run(ctx => ctx.db.patch(f.revisionId, { body: input.body, citations: input.citations }))
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "PRIVATE_LARGE_REPORT_STATEMENT",
    }))
    const snapshot = (await t.run(ctx => caseView(ctx, caseId, { admin: true })))!.evidence[0]
    const cases = [caseId]
    await t.run(async ctx => decide(ctx, (await ctx.db.get(caseId))!, "accept", "fixture-admin", "Fixture admission"))
    const conduct = (await t.run(ctx => ctx.db.query("moderationCases").withIndex("by_parent", q => q.eq("parentCaseId", caseId)).unique()))!
    cases.push(conduct._id)
    await t.run(ctx => decide(ctx, conduct, "accept", "fixture-admin", "Fixture conduct decision"))
    const appeal = await t.run(async ctx => openAppeal(ctx, f.author.agent.ownerId!, (await ctx.db.get(conduct._id))!, "Fixture appeal reason"))
    cases.push(appeal.caseId)
    for (const id of cases) {
      // convex-test enforces transaction byte budgets, but not the separate
      // document limit; explicitly measure each stored JSON document as well.
      const rows = await t.run(ctx => ctx.db.query("moderationEvidence").withIndex("by_case", q => q.eq("caseId", id)).collect())
      for (const row of rows) expect(Buffer.byteLength(JSON.stringify(row))).toBeLessThan(1024 * 1024)
      const full = (await t.run(ctx => caseView(ctx, id, { admin: true })))!
      expect(full.evidence).toContainEqual(snapshot)
      const subject = (await t.run(ctx => caseView(ctx, id, { agentId: f.author.agent._id, ownerId: f.author.agent.ownerId })))!
      expect(subject.evidence.some(e => JSON.parse(e.content.startsWith("{") ? e.content : "{}").body === input.body)).toBe(true)
      expect(JSON.stringify(subject.evidence)).not.toContain("PRIVATE_LARGE_REPORT_STATEMENT")
    }
  })

  it("separates an agent reporter's own statement from withheld subject content", async () => {
    const t = setup(), f = await fixture(t)
    await t.run(ctx => ctx.db.patch(f.revisionId, { quarantined: true }))
    const receipt = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "PRIVATE_REPORTER_STATEMENT_MARKER",
    }))
    expect(await t.query(api.public.getResource, { slugOrId: f.id, revisionId: f.revisionId })).toBeNull()
    const reporter = await t.run(ctx => caseView(ctx, receipt.caseId, { agentId: f.reviewer.agent._id, ownerId: f.reviewer.agent.ownerId }))
    expect(JSON.stringify(reporter)).toContain("PRIVATE_REPORTER_STATEMENT_MARKER")
    expect(JSON.stringify(reporter)).not.toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    const subject = await t.run(ctx => caseView(ctx, receipt.caseId, { agentId: f.author.agent._id, ownerId: f.author.agent.ownerId }))
    expect(JSON.stringify(subject)).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    expect(JSON.stringify(subject)).not.toContain("PRIVATE_REPORTER_STATEMENT_MARKER")
    expect(JSON.stringify(await t.run(ctx => caseView(ctx, receipt.caseId, { admin: true })))).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
  })

  it("does not give participants unclassified legacy snapshots", async () => {
    const t = setup(), f = await fixture(t)
    const id = await t.run(ctx => createCase(ctx, {
      kind: "admission", reason: "spam", targetKind: "agent", targetId: f.author.agent._id,
      subjectId: f.author.agent._id, reporterId: f.reviewer.agent._id, reporterOwnerId: f.reviewer.agent.ownerId, dedupeKey: "legacy",
      evidence: "LEGACY_PRIVATE_SNAPSHOT_MARKER", provenance: "Legacy intake",
    }))
    const reporter = await t.run(ctx => caseView(ctx, id, { agentId: f.reviewer.agent._id, ownerId: f.reviewer.agent.ownerId }))
    expect(reporter?.evidence).toEqual([])
    const subject = await t.run(ctx => caseView(ctx, id, { agentId: f.author.agent._id, ownerId: f.author.agent.ownerId }))
    expect(subject?.evidence).toEqual([])
    expect(JSON.stringify(await t.run(ctx => caseView(ctx, id, { admin: true })))).toContain("LEGACY_PRIVATE_SNAPSHOT_MARKER")
  })

  it("limits an authenticated human reporter to their own statement", async () => {
    vi.stubEnv("MODERATION_ENABLED", "false")
    const t = setup(), f = await fixture(t), reporter = await human(t), other = await human(t)
    await t.run(ctx => ctx.db.patch(f.revisionId, { quarantined: true }))
    const result = await reporter.client.mutation(api.moderationHumans.report, { input: {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "HUMAN_REPORTER_STATEMENT_MARKER",
    } })
    const caseId = result.caseId
    if (!caseId) throw new Error("Human fixture report failed")
    const own = await reporter.client.query(api.moderationHumans.detail, { caseId })
    expect(JSON.stringify(own)).toContain("HUMAN_REPORTER_STATEMENT_MARKER")
    expect(JSON.stringify(own)).not.toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    expect(await other.client.query(api.moderationHumans.detail, { caseId })).toBeNull()
    await t.run(ctx => ctx.db.patch(caseId, { public: true }))
    expect((await other.client.query(api.moderationHumans.detail, { caseId }))?.evidence).toEqual([])
    expect((await t.run(ctx => caseView(ctx, caseId)))?.evidence).toEqual([])
  })

  it.each(["invited", "accepted", "declined", "owner mismatch", "restricted", "unapproved", "new conflict"])("checks current juror authority: %s", async state => {
    const t = setup(), f = await fixture(t), juror = await actor(t, "fixture-juror-owner")
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "PRIVATE_REPORTER_STATEMENT_MARKER",
    }))
    await t.run(async ctx => {
      await ctx.db.patch(caseId, { public: true })
      await ctx.db.insert("approvedOwners", { ownerId: juror.agent.ownerId!, approved: state !== "unapproved", decidedBy: "fixture-admin", reason: "Fixture approved owner", updatedAt: Date.now() })
      const taskId = await ctx.db.insert("tasks", { committeeCaseId: caseId, type: "committee_review", topic: "moderation",
        title: "Private jury", description: "Private evidence", dedupeKey: "jury-fixture", status: "open", issueOpen: false, random: 0, updatedAt: Date.now() })
      await ctx.db.insert("committeeSeats", { caseId, taskId, agentId: juror.agent._id, ownerId: juror.agent.ownerId!, weight: 1,
        accepted: state === "accepted", declined: state === "declined" })
      if (state === "owner mismatch") await ctx.db.patch(juror.agent._id, { ownerId: "different-owner" })
      if (state === "restricted") await ctx.db.patch(juror.agent._id, { blocked: true })
      if (state === "new conflict") await ctx.db.insert("revisions", { resourceId: f.id, authorId: juror.agent._id,
        title: "New contribution", body: "Safe", summary: "Safe", status: "published", citations: [], attachmentIds: [], suppressed: false })
    })
    const view = await t.run(ctx => caseView(ctx, caseId, { agentId: juror.agent._id, ownerId: juror.agent.ownerId }))
    if (["invited", "accepted"].includes(state)) {
      expect(JSON.stringify(view)).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
      expect(JSON.stringify(view)).toContain("PRIVATE_REPORTER_STATEMENT_MARKER")
      expect(view?.ownSeat).not.toBeNull()
    } else {
      expect(view?.evidence).toEqual([])
      expect(view?.ownSeat).toBeNull()
    }
    expect(JSON.stringify(await t.run(ctx => caseView(ctx, caseId, { admin: true })))).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
  })

  it("does not expose another reporter's statements to the subject during an appeal", async () => {
    const t = setup(), f = await fixture(t)
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "OTHER_REPORTER_STATEMENT_MARKER",
    }))
    const appeal = await t.run(async ctx => {
      await ctx.db.patch(caseId, { kind: "conduct", state: "resolved", decision: "accept", resolvedAt: Date.now() })
      return openAppeal(ctx, f.author.agent.ownerId!, (await ctx.db.get(caseId))!, "OWN_APPEAL_STATEMENT_MARKER")
    })
    const subject = await t.run(ctx => caseView(ctx, appeal.caseId, { ownerId: f.author.agent.ownerId }))
    expect(JSON.stringify(subject)).toContain("OWN_APPEAL_STATEMENT_MARKER")
    expect(JSON.stringify(subject)).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    expect(JSON.stringify(subject)).not.toContain("OTHER_REPORTER_STATEMENT_MARKER")
    expect(JSON.stringify(await t.run(ctx => caseView(ctx, appeal.caseId, { admin: true })))).toContain("OTHER_REPORTER_STATEMENT_MARKER")
  })

  it("does not expose snapshots to mismatched owners or reuse stale appeal claims", async () => {
    const t = setup(), f = await fixture(t)
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "PRIVATE_REPORTER_STATEMENT_MARKER",
    }))
    expect(await t.run(ctx => caseView(ctx, caseId, { agentId: f.reviewer.agent._id, ownerId: "wrong-owner" }))).toBeNull()
    await t.run(async ctx => {
      await ctx.db.insert("appealClaims", { agentId: f.author.agent._id, ownerId: "old-claim-owner", provenAt: Date.now() })
      await ctx.db.patch(caseId, { public: true })
    })
    const stale = await t.run(ctx => caseView(ctx, caseId, { ownerId: "old-claim-owner", appealAgentId: f.author.agent._id }))
    expect(stale?.evidence).toEqual([])
  })

  it("allows verified appeal proof to read only the unlinked subject's authored material", async () => {
    const t = setup(), f = await fixture(t)
    await t.run(ctx => ctx.db.patch(f.author.agent._id, { ownerId: undefined }))
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "PRIVATE_REPORTER_STATEMENT_MARKER",
    }))
    await t.run(ctx => ctx.db.insert("appealClaims", { agentId: f.author.agent._id, ownerId: "proven-owner", provenAt: Date.now() }))
    const view = await t.run(ctx => caseView(ctx, caseId, { ownerId: "proven-owner", appealAgentId: f.author.agent._id }))
    expect(JSON.stringify(view)).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    expect(JSON.stringify(view)).not.toContain("PRIVATE_REPORTER_STATEMENT_MARKER")
  })

  it("authorizes an independent juror without reading large revision histories", async () => {
    const t = setup(true), f = await fixture(t), juror = await actor(t, "bounded-juror")
    // Intake itself predates this case-view check. Build the history afterward
    // so this regression isolates the read boundary from existing intake work.
    const { caseId } = await t.run(ctx => reportAbuse(ctx, f.reviewer.agent, {
      targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "A bounded fixture report for independent review.",
    }))
    await t.run(async ctx => {
      await ctx.db.insert("approvedOwners", { ownerId: juror.agent.ownerId!, approved: true, decidedBy: "fixture-admin", reason: "Fixture approved owner", updatedAt: Date.now() })
      const taskId = await ctx.db.insert("tasks", { committeeCaseId: caseId, type: "committee_review", topic: "moderation", title: "Jury", description: "Private evidence", dedupeKey: "bounded-jury", status: "open", issueOpen: false, random: 0, updatedAt: Date.now() })
      await ctx.db.insert("committeeSeats", { caseId, taskId, agentId: juror.agent._id, ownerId: juror.agent.ownerId!, weight: 1, accepted: true, declined: false })
    })
    for (let page = 0; page < 3; page++) await t.run(async ctx => {
      for (let n = 0; n < 60; n++) await ctx.db.insert("revisions", { resourceId: f.id, authorId: f.author.agent._id,
        title: "Historical fixture", body: "x".repeat(100000), summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false })
    })
    const view = await t.run(ctx => caseView(ctx, caseId, { agentId: juror.agent._id, ownerId: juror.agent.ownerId }))
    expect(JSON.stringify(view)).toContain("HIDDEN_TARGET_BOUNDARY_MARKER")
    // A sibling contribution must revoke access even when the juror has never
    // personally edited the article.
    const sibling = await actor(t, juror.agent.ownerId)
    await t.run(ctx => ctx.db.insert("revisions", { resourceId: f.id, authorId: sibling.agent._id,
      title: "Sibling edit", body: "Safe", summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false }))
    expect(await t.run(ctx => caseView(ctx, caseId, { agentId: juror.agent._id, ownerId: juror.agent.ownerId }))).toBeNull()
  })
})
