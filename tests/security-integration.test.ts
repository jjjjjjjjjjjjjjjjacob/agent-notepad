/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { digest } from "../lib/hash"
import { DAY } from "../lib/moderation-policy"
import { recomputeCommunity } from "../convex/moderation/reputation"
import { createCase } from "../convex/moderation/cases"
import { closeRound } from "../convex/moderation/rounds"
import { ModerationCapacityExceeded } from "../convex/moderation/authorship"
import { setHold, liftCase } from "../convex/moderation/sanctions"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest({ schema, modules, transactionLimits: true })
type Test = ReturnType<typeof setup>
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("MODERATION_ENABLED", "false")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
async function actor(t: Test, slug: string) {
  const token = `integration-fixture-${slug}`,
    ownerId = `owner-${slug}`
  const result = await t.mutation(internal.agents.create, {
    input: { name: slug, slug },
    hash: digest(token),
    prefix: "fixture",
  })
  await t.run(async (ctx) => {
    await ctx.db.patch(result.agentId, { ownerId })
    await ctx.db.insert("approvedOwners", {
      ownerId,
      approved: true,
      decidedBy: "fixture",
      reason: "Fixture approval",
      updatedAt: Date.now(),
    })
  })
  return { ...result, token, ownerId }
}
async function caseFor(t: Test, agentId: Id<"agents">, targetId: string) {
  return t.run((ctx) =>
    ctx.db.insert("moderationCases", {
      kind: "conduct",
      reason: "prompt_injection",
      targetKind: "revision",
      targetId,
      subjectId: agentId,
      dedupeKey: crypto.randomUUID(),
      policyVersion: 1,
      state: "resolved",
      public: true,
      seatingUntil: Date.now(),
      deadline: Date.now(),
      excludedOwners: [],
      excludedAgents: [],
      candidates: [],
      candidateCursor: 0,
      rosterDay: 0,
    })
  )
}

it("hides held task source text immediately while community credit reconciles and public scores remain atomic", async () => {
  const t = setup(),
    author = await actor(t, "integration-author")
  const source = await t.run(async (ctx) => {
    const id = await ctx.db.insert("resources", {
      kind: "post",
      slug: "integration-post",
      title: "Fixture post",
      excerpt: "Fixture",
      authorId: author.agentId,
      topic: "fixture",
      score: 5,
      commentCount: 0,
      disputed: false,
      suppressed: false,
      protection: "open",
      updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id,
      authorId: author.agentId,
      title: "Fixture post",
      body: "Fixture source",
      summary: "Fixture",
      citations: [],
      attachmentIds: [],
      status: "published",
      suppressed: false,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    const taskId = await ctx.db.insert("tasks", {
      type: "citation",
      topic: "fixture",
      title: "HELD_SOURCE_TASK_MARKER",
      description: "Fixture source details",
      targetId: id,
      revisionId,
      sourceRevisionId: revisionId,
      creatorId: author.agentId,
      dedupeKey: "integration-source-task",
      status: "open",
      issueOpen: true,
      random: 0,
      updatedAt: Date.now(),
    })
    return { id, revisionId, taskId }
  })
  const voters = []
  for (let i = 0; i < 5; i++) {
    const voter = await actor(t, `integration-voter-${i}`)
    voters.push(voter)
    await t.run((ctx) =>
      ctx.db.insert("votes", {
        resourceId: source.id,
        agentId: voter.agentId,
        value: 1,
      })
    )
  }
  const award = () =>
    t.run((ctx) =>
      ctx.db
        .query("reputationEvents")
        .withIndex("by_source", (q) =>
          q.eq("source", "post").eq("sourceId", source.id)
        )
        .unique()
    )
  await t.run((ctx) => recomputeCommunity(ctx, source.id))
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  const original = await award()
  expect(original?.points).toBe(1)
  expect(
    await t.query(api.public.getTask, { id: source.taskId })
  ).toMatchObject({ title: "HELD_SOURCE_TASK_MARKER" })
  const caseId = await caseFor(t, author.agentId, source.revisionId)
  await t.run((ctx) => setHold(ctx, caseId, source.revisionId))
  expect(await t.query(api.public.getTask, { id: source.taskId })).toBeNull()
  expect(
    await t.query(api.public.getResource, { slugOrId: source.id })
  ).toBeNull()
  expect((await t.run((ctx) => ctx.db.get(source.id)))?.score).toBe(5)
  expect(
    (
      await t.run((ctx) =>
        ctx.db
          .query("communityRecomputeJobs")
          .withIndex("by_resource", (q) => q.eq("resourceId", source.id))
          .unique()
      )
    )?.running
  ).toBe(true)
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect((await award())?.reversedAt).toBeDefined()
  await t.run(async (ctx) => liftCase(ctx, (await ctx.db.get(caseId))!))
  expect(
    await t.query(api.public.getTask, { id: source.taskId })
  ).toMatchObject({ title: "HELD_SOURCE_TASK_MARKER" })
  await expect(
    t.mutation(internal.commands.execute, {
      token: voters[0].token,
      operation: "vote",
      input: { resourceId: source.id, value: 0 },
    })
  ).resolves.toMatchObject({ score: 4 })
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect((await award())?.reversedAt).toBeDefined()
  await expect(
    t.mutation(internal.commands.execute, {
      token: voters[0].token,
      operation: "vote",
      input: { resourceId: source.id, value: 1 },
    })
  ).resolves.toMatchObject({ score: 5 })
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(await award()).toMatchObject({
    _id: original!._id,
    maturesAt: original!.maturesAt,
  })
  expect((await award())?.reversedAt).toBeUndefined()
})

it("retires large separated forensic/subject evidence without exposing partial inheritance", async () => {
  const t = setup(),
    subject = await actor(t, "integration-subject")
  const cases: Id<"moderationCases">[] = []
  for (let i = 0; i < 20; i++) {
    const caseId = await t.run((ctx) =>
      createCase(ctx, {
        kind: "conduct",
        reason: "prompt_injection",
        targetKind: "agent",
        targetId: subject.agentId,
        subjectId: subject.agentId,
        dedupeKey: `integration-evidence-${i}`,
        evidence: "FORENSIC_MARKER" + "x".repeat(600_000),
        provenance: "Fixture forensic record",
        subjectEvidence: {
          agentId: subject.agentId,
          content: "SUBJECT_PROJECTION_MARKER" + "y".repeat(600_000),
        },
      })
    )
    cases.push(caseId)
    await t.run((ctx) =>
      ctx.db.patch(caseId, {
        state: "resolved",
        resolvedAt: Date.now() - 91 * DAY,
      })
    )
  }
  // The first parent has more than one deletion page; both audience classes
  // must remain protected by the guard until their complete retirement.
  await t.run((ctx) =>
    ctx.db.insert("moderationEvidence", {
      caseId: cases[0],
      content: "Additional preserved attribution",
      fingerprint: "fixture",
      provenance: "Fixture",
      audience: { kind: "statement", ownerId: subject.ownerId },
    })
  )
  await t.mutation(internal.governance.retention, {})
  await t.mutation(internal.governance.retireEvidence, {
    generation: 1,
    step: 0,
  })
  await t.mutation(internal.governance.retireEvidence, {
    generation: 1,
    step: 1,
  })
  expect(
    (await t.run((ctx) => ctx.db.get(cases[0])))?.evidencePurgedAt
  ).toBeUndefined()
  await expect(
    t.run((ctx) =>
      createCase(ctx, {
        kind: "appeal",
        reason: "prompt_injection",
        targetKind: "agent",
        targetId: subject.agentId,
        subjectId: subject.agentId,
        parentCaseId: cases[0],
        dedupeKey: "integration-partial-child",
        provenance: "Fixture child",
      })
    )
  ).rejects.toThrow("retiring expired evidence")
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("moderationCases")
        .withIndex("by_parent", (q) => q.eq("parentCaseId", cases[0]))
        .collect()
    )
  ).toEqual([])
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(
    await t.run((ctx) => ctx.db.query("moderationEvidence").collect())
  ).toEqual([])
  for (const id of cases) {
    const c = await t.run((ctx) => ctx.db.get(id))
    expect(c?.evidencePurgedAt).toBeDefined()
    expect(c?.evidenceRetiringAt).toBeUndefined()
  }
})

it.each(["decision-failure", "success", "preflight-saturation"] as const)(
  "keeps admission closure atomic through %s",
  async (mode) => {
    const t = setup(),
      subject = await actor(t, `closure-subject-${mode}`)
    const caseId = await caseFor(t, subject.agentId, subject.agentId)
    const taskIds: Id<"tasks">[] = []
    await t.run(async (ctx) => {
      await ctx.db.patch(caseId, {
        kind: "admission",
        reason: "spam",
        targetKind: "agent",
        state: "voting",
        deadline: Date.now() - 1,
        ...(mode === "preflight-saturation"
          ? { authorshipState: "incomplete" as const }
          : {}),
      })
      for (let i = 0; i < (mode === "decision-failure" ? 33 : 1); i++)
        await ctx.db.insert("moderationEvidence", {
          caseId,
          content: `Harmless legacy forensic row ${i}`,
          fingerprint: `legacy-${i}`,
          provenance: "Legacy fixture",
        })
    })
    for (let i = 0; i < 3; i++) {
      const juror = await actor(t, `closure-juror-${mode}-${i}`)
      taskIds.push(
        await t.run(async (ctx) => {
          const taskId = await ctx.db.insert("tasks", {
            committeeCaseId: caseId,
            type: "committee_review",
            topic: "moderation",
            title: "Fixture admission",
            description: "Fixture",
            dedupeKey: `closure-${mode}-${i}`,
            status: "submitted",
            issueOpen: true,
            random: 0,
            updatedAt: Date.now(),
          })
          await ctx.db.insert("committeeSeats", {
            caseId,
            agentId: juror.agentId,
            ownerId: juror.ownerId,
            weight: 1,
            taskId,
            accepted: true,
            declined: false,
            vote: "accept",
            rationale: "Harmless fixture vote",
            votedAt: Date.now() - 1,
          })
          return taskId
        })
      )
    }
    const close = () =>
      t.run(async (ctx) => closeRound(ctx, (await ctx.db.get(caseId))!))
    if (mode === "decision-failure")
      await expect(close()).rejects.toThrow(ModerationCapacityExceeded)
    else await close()
    const parent = (await t.run((ctx) => ctx.db.get(caseId)))!
    const children = await t.run((ctx) =>
      ctx.db
        .query("moderationCases")
        .withIndex("by_parent", (q) => q.eq("parentCaseId", caseId))
        .collect()
    )
    const audits = await t.run((ctx) =>
      ctx.db
        .query("moderationAudit")
        .withIndex("by_target", (q) => q.eq("targetId", caseId))
        .collect()
    )
    if (mode === "success") {
      expect(parent).toMatchObject({ state: "resolved", decision: "accept" })
      expect(children).toHaveLength(1)
      expect(audits.some((row) => row.action === "decision_accept")).toBe(true)
    } else {
      expect(parent.state).toBe(
        mode === "decision-failure" ? "voting" : "escalated"
      )
      expect(parent.decision).toBeUndefined()
      expect(parent.resolvedAt).toBeUndefined()
      expect(children).toEqual([])
      expect(audits.some((row) => row.action.startsWith("decision_"))).toBe(
        false
      )
      if (mode === "decision-failure")
        for (const id of taskIds)
          expect((await t.run((ctx) => ctx.db.get(id)))?.status).toBe(
            "submitted"
          )
    }
  }
)
