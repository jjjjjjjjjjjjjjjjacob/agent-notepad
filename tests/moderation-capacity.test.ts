/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, internal, components } from "../convex/_generated/api"
import type { Doc, Id } from "../convex/_generated/dataModel"
import { commandSchemas } from "../lib/contracts"
import { reportAbuse, openAppeal, createCase } from "../convex/moderation/cases"
import { fillSeats, respond, ballot, closeRound, releaseSeats } from "../convex/moderation/rounds"
import { decide } from "../convex/moderation/decisions"
import { caseView } from "../convex/moderation/reads"
import { caseConflict, moderationReads, juryScore, MAX_CANDIDATES } from "../convex/moderation/authorship"
import { DAY } from "../lib/moderation-policy"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => {
  const t = convexTest({ schema, modules, transactionLimits: true })
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

async function agent(t: Test, ownerId: string) {
  return t.run(async ctx => {
    const id = await ctx.db.insert("agents", {
      name: "Capacity fixture", slug: crypto.randomUUID(), bio: "", ownerId,
      capabilities: [], topics: [], role: "editor", blocked: false,
      contributionCount: 0, reviewCount: 0, updatedAt: Date.now(),
    })
    if (!await ctx.db.query("approvedOwners").withIndex("by_owner", q => q.eq("ownerId", ownerId)).unique()) await ctx.db.insert("approvedOwners", {
      ownerId, approved: true, decidedBy: "fixture-admin", reason: "Fixture approval", updatedAt: Date.now(),
    })
    return (await ctx.db.get(id))!
  })
}

async function fixture(t: Test) {
  const author = await agent(t, "capacity-author"), reporter = await agent(t, "capacity-reporter")
  const resource = await t.run(async ctx => {
    const id = await ctx.db.insert("resources", {
      kind: "wiki", slug: "capacity-article", title: "Capacity article", excerpt: "Fixture",
      authorId: author._id, topic: "fixture", score: 0, commentCount: 0,
      disputed: false, suppressed: false, protection: "open", updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id, authorId: author._id, title: "Capacity article", body: "Safe fixture",
      summary: "Fixture", citations: [], attachmentIds: [], status: "published", suppressed: false,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    return { id, revisionId }
  })
  return { ...resource, author, reporter }
}

async function longHistory(t: Test, resourceId: Id<"resources">, author: Doc<"agents">, count = 40) {
  const input = commandSchemas.publish.parse({
    kind: "wiki", title: "Capacity fixture", body: "a".repeat(100000),
    citations: Array.from({ length: 30 }, (_, n) => ({
      url: `https://example.test/${n}/${"a".repeat(2000)}`, title: "界".repeat(200), quote: "界".repeat(4000),
    })),
  })
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(530000)
  expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(600000)
  // Normal publications write separately; only the moderation read combines
  // their sizes. These transactions exercise convex-test's real byte budgets.
  for (let n = 0; n < count; n++) await t.run(ctx => ctx.db.insert("revisions", {
    resourceId, authorId: author._id, title: input.title, body: input.body,
    summary: "Historical fixture", citations: input.citations, attachmentIds: [], status: "published", suppressed: false,
  }))
  return input
}

async function report(t: Test, f: Awaited<ReturnType<typeof fixture>>) {
  return t.run(ctx => reportAbuse(ctx, f.reporter, {
    targetKind: "revision", targetId: f.revisionId, reason: "spam", description: "Harmless capacity test report.",
  }))
}

async function human(t: Test) {
  const user = await t.mutation(components.betterAuth.adapter.create, { input: { model: "user", data: {
    name: "Capacity human", email: `${crypto.randomUUID()}@example.test`, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now(),
  } } })
  const session = await t.mutation(components.betterAuth.adapter.create, { input: { model: "session", data: {
    userId: user._id, token: crypto.randomUUID(), expiresAt: Date.now() + DAY, createdAt: Date.now(), updatedAt: Date.now(),
  } } })
  return { id: user._id, client: t.withIdentity({ subject: user._id, sessionId: session._id }) }
}

async function invite(t: Test, caseId: Id<"moderationCases">, juror: Doc<"agents">) {
  await t.run(async ctx => {
    await ctx.db.patch(caseId, { state: "seating", candidates: [{ agentId: juror._id, ownerId: juror.ownerId!, weight: 1 }] })
    await fillSeats(ctx, (await ctx.db.get(caseId))!)
  })
}

async function mature(t: Test, juror: Doc<"agents">, points = 12, revisionId?: Id<"revisions">) {
  await t.run(ctx => ctx.db.insert("reputationEvents", { agentId: juror._id, ownerId: juror.ownerId!,
    source: "task", sourceId: crypto.randomUUID(), points, maturesAt: Date.now() - 1, expiresAt: Date.now() + 30 * DAY,
    policyVersion: 1, day: Math.floor(Date.now() / DAY), ...(revisionId ? { revisionId } : {}),
  }))
}

describe("bounded moderation authorship", () => {
  it("accepts reports against long histories of large contract-valid revisions", async () => {
    const t = setup(), f = await fixture(t)
    await longHistory(t, f.id, f.author)
    const { caseId } = await report(t, f)
    expect(await t.run(ctx => ctx.db.get(caseId))).toMatchObject({ state: "queued", subjectId: f.author._id })
  })

  it("seats an independent juror without reading the large revision history", async () => {
    const t = setup(), f = await fixture(t), juror = await agent(t, "capacity-juror")
    const { caseId } = await report(t, f)
    await longHistory(t, f.id, f.author)
    await t.run(async ctx => {
      await ctx.db.patch(caseId, { state: "seating", candidates: [{ agentId: juror._id, ownerId: juror.ownerId!, weight: 1 }] })
      await fillSeats(ctx, (await ctx.db.get(caseId))!)
    })
    const seats = await t.run(ctx => ctx.db.query("committeeSeats").withIndex("by_case", q => q.eq("caseId", caseId)).collect())
    expect(seats).toHaveLength(1)
    expect(seats[0]).toMatchObject({ agentId: juror._id, declined: false })
  })

  it("retains evidence and denies ordinary decisions when distinct-author snapshots saturate", async () => {
    const t = setup(), f = await fixture(t), admin = await human(t), juror = await agent(t, "saturation-juror")
    for (let n = 0; n < 12; n++) await longHistory(t, f.id, await agent(t, `distinct-${n}`), 1)
    const { caseId } = await report(t, f)
    expect(await t.run(ctx => ctx.db.get(caseId))).toMatchObject({ state: "escalated", authorshipState: "incomplete" })
    expect((await t.run(ctx => caseView(ctx, caseId, { admin: true })))?.evidence.length).toBeGreaterThan(0)
    vi.stubEnv("MODERATION_ADMIN_USER_IDS", admin.id)
    for (const action of ["decide", "extend_hold", "reopen"] as const)
      await expect(admin.client.mutation(api.moderationHumans.adminAction, { action, targetId: caseId, enabled: true, reason: "Harmless administrator capacity fixture." })).rejects.toThrow("recovery procedure")
    await invite(t, caseId, juror)
    expect((await t.run(ctx => ctx.db.get(caseId)))?.state).toBe("escalated")
    expect(await t.run(ctx => caseView(ctx, caseId, { agentId: juror._id, ownerId: juror.ownerId }))).toBeNull()
  })

  it("keeps large evidence usable through admission, conduct and appeal with several authors", async () => {
    const t = setup(), f = await fixture(t)
    const input = await longHistory(t, f.id, f.author, 1)
    await t.run(ctx => ctx.db.patch(f.revisionId, { body: input.body, citations: input.citations }))
    for (let n = 0; n < 3; n++) await longHistory(t, f.id, await agent(t, `transition-author-${n}`), 1)
    const { caseId } = await report(t, f)
    const full = (await t.run(ctx => caseView(ctx, caseId, { admin: true })))!.evidence[0]
    expect((await t.run(ctx => ctx.db.get(caseId)))?.authorshipState).toBe("complete")
    await t.run(async ctx => decide(ctx, (await ctx.db.get(caseId))!, "accept", "capacity-admin", "Fixture admission"))
    const conduct = (await t.run(ctx => ctx.db.query("moderationCases").withIndex("by_parent", q => q.eq("parentCaseId", caseId)).unique()))!
    expect(conduct.authorshipState).toBe("complete")
    await t.run(ctx => decide(ctx, conduct, "accept", "capacity-admin", "Fixture conduct decision"))
    const appeal = await t.run(async ctx => openAppeal(ctx, f.author.ownerId!, (await ctx.db.get(conduct._id))!, "Harmless appeal fixture."))
    expect((await t.run(ctx => ctx.db.get(appeal.caseId)))?.authorshipState).toBe("complete")
    expect((await t.run(ctx => caseView(ctx, appeal.caseId, { admin: true })))?.evidence).toContainEqual(full)
  })

  it("preserves frozen owners and checks later author reassignment and sibling ownership live", async () => {
    const t = setup(), f = await fixture(t), prior = await agent(t, "frozen-owner"), newcomer = await agent(t, "later-owner")
    await longHistory(t, f.id, prior, 1)
    const { caseId } = await report(t, f)
    await t.run(ctx => ctx.db.patch(prior._id, { ownerId: newcomer.ownerId }))
    for (const owner of ["frozen-owner", "later-owner"])
      expect(await t.run(async ctx => caseConflict(moderationReads(ctx), (await ctx.db.get(caseId))!, owner))).toBe(true)
    expect(await t.run(async ctx => caseConflict(moderationReads(ctx), (await ctx.db.get(caseId))!, "independent-owner"))).toBe(false)
    const unlinked = await agent(t, "temporary-owner")
    await t.run(ctx => ctx.db.patch(unlinked._id, { ownerId: undefined }))
    await longHistory(t, f.id, { ...unlinked, ownerId: undefined }, 1)
    await t.run(ctx => ctx.db.patch(unlinked._id, { ownerId: "newly-linked-owner" }))
    expect(await t.run(async ctx => caseConflict(moderationReads(ctx), (await ctx.db.get(caseId))!, "newly-linked-owner"))).toBe(true)
  })

  it.each(["sibling edit", "removed approval", "changed owner", "declined"])("withdraws a stale juror at evidence, acceptance and voting: %s", async change => {
    const t = setup(), f = await fixture(t), juror = await agent(t, "live-juror")
    vi.setSystemTime(Date.now() + 15 * DAY)
    await mature(t, juror)
    const { caseId } = await report(t, f)
    await invite(t, caseId, juror)
    const seat = (await t.run(ctx => ctx.db.query("committeeSeats").withIndex("by_case", q => q.eq("caseId", caseId)).unique()))!
    if (change === "sibling edit") await longHistory(t, f.id, await agent(t, juror.ownerId!), 1)
    if (change === "removed approval") await t.run(async ctx => ctx.db.patch((await ctx.db.query("approvedOwners").withIndex("by_owner", q => q.eq("ownerId", juror.ownerId!)).unique())!._id, { approved: false }))
    if (change === "changed owner") await t.run(ctx => ctx.db.patch(juror._id, { ownerId: "different-owner" }))
    if (change === "declined") await t.run(ctx => ctx.db.patch(seat._id, { declined: true }))
    expect(await t.run(ctx => caseView(ctx, caseId, { agentId: juror._id, ownerId: juror.ownerId }))).toBeNull()
    await expect(t.run(ctx => respond(ctx, juror, caseId, true))).rejects.toThrow()
    await t.run(async ctx => {
      await ctx.db.patch(caseId, { state: "voting" })
      await ctx.db.patch(seat._id, { accepted: true })
    })
    await expect(t.run(ctx => ballot(ctx, juror, caseId, 1, "accept", "Harmless vote fixture."))).rejects.toThrow()
  })

  it("checks author conflicts on administrator actions and preserves reopened resource ancestry", async () => {
    const t = setup(), f = await fixture(t), admin = await human(t), independent = await human(t)
    const { caseId } = await report(t, f)
    await t.run(ctx => ctx.db.patch(caseId, { kind: "conduct", state: "escalated" }))
    await longHistory(t, f.id, await agent(t, admin.id), 1)
    vi.stubEnv("MODERATION_ADMIN_USER_IDS", `${admin.id},${independent.id}`)
    for (const action of ["decide", "extend_hold", "reopen"] as const)
      await expect(admin.client.mutation(api.moderationHumans.adminAction, { action, targetId: caseId, enabled: true, reason: "Harmless administrator conflict fixture." })).rejects.toThrow("nonconflicted")
    await independent.client.mutation(api.moderationHumans.adminAction, { action: "decide", targetId: caseId, enabled: true, reason: "Harmless independent decision fixture." })
    await independent.client.mutation(api.moderationHumans.adminAction, { action: "reopen", targetId: caseId, enabled: true, reason: "Harmless independent reopening fixture." })
    const reopened = (await t.run(ctx => ctx.db.query("moderationCases").withIndex("by_parent", q => q.eq("parentCaseId", caseId)).unique()))!
    expect(reopened).toMatchObject({ resourceId: f.id, revisionId: f.revisionId })
    // Legacy children without resource IDs still resolve authoritative ancestry.
    await t.run(ctx => ctx.db.patch(reopened._id, { resourceId: undefined, revisionId: undefined }))
    expect(await t.run(async ctx => caseConflict(moderationReads(ctx), (await ctx.db.get(reopened._id))!, admin.id))).toBe(true)
  })

  it("escalates excessive owner fanout instead of seating or disclosing to an uncertain juror", async () => {
    const t = setup(), f = await fixture(t), juror = await agent(t, "many-siblings")
    for (let n = 0; n < 64; n++) await agent(t, juror.ownerId!)
    const { caseId } = await report(t, f)
    await invite(t, caseId, juror)
    expect((await t.run(ctx => ctx.db.get(caseId)))?.state).toBe("escalated")
    expect(await t.run(ctx => caseView(ctx, caseId, { agentId: juror._id, ownerId: juror.ownerId }))).toBeNull()
  })

  it("never installs a partial roster when nomination capacity is exceeded", async () => {
    const t = setup(), f = await fixture(t)
    await t.run(async ctx => {
      for (let n = 0; n <= MAX_CANDIDATES; n++) await ctx.db.insert("juryNominations", {
        ownerId: `nomination-${n}`, agentId: f.author._id, available: true, effectiveDay: Math.floor(Date.now() / DAY),
      })
    })
    await t.mutation(internal.governance.freezeRoster, {})
    expect(await t.run(ctx => ctx.db.query("juryRoster").collect())).toEqual([])
    expect(await t.run(ctx => ctx.db.query("juryEpochs").unique())).toMatchObject({ state: "saturated" })
    const { caseId } = await report(t, f)
    expect(await t.query(internal.governance.drawCandidates, { caseId })).toEqual({ saturated: true, candidates: [] })
  })

  it("shares roster byte capacity across candidates and installs no partially evaluated population", async () => {
    const t = setup(), f = await fixture(t), ordinary = await agent(t, "ordinary-roster"), costly = await agent(t, "costly-roster")
    vi.setSystemTime(Date.now() + 15 * DAY)
    await mature(t, ordinary)
    const input = await longHistory(t, f.id, f.author, 1)
    for (let n = 0; n < 24; n++) {
      const revisionId = await t.run(ctx => ctx.db.insert("revisions", { resourceId: f.id, authorId: f.author._id,
        title: input.title, body: input.body, summary: "Capacity award fixture", citations: input.citations,
        attachmentIds: [], status: "published", suppressed: false,
      }))
      await mature(t, costly, 3, revisionId)
    }
    await t.run(async ctx => {
      for (const nominee of [ordinary, costly]) await ctx.db.insert("juryNominations", {
        ownerId: nominee.ownerId!, agentId: nominee._id, available: true, effectiveDay: Math.floor(Date.now() / DAY),
      })
    })
    await t.mutation(internal.governance.freezeRoster, {})
    expect(await t.run(ctx => ctx.db.query("juryRoster").collect())).toEqual([])
    expect(await t.run(ctx => ctx.db.query("juryEpochs").unique())).toMatchObject({ state: "saturated" })
  })

  it("preserves exact jury scores while ignoring held, reversed and immature awards", async () => {
    const t = setup(), f = await fixture(t), juror = await agent(t, "score-juror")
    await mature(t, juror, 20)
    await mature(t, juror, 15, f.revisionId)
    await t.run(async ctx => {
      await ctx.db.patch(f.revisionId, { quarantined: true })
      for (const change of [{ maturesAt: Date.now() + DAY }, { reversedAt: Date.now() }]) await ctx.db.insert("reputationEvents", {
        agentId: juror._id, ownerId: juror.ownerId!, source: "task", sourceId: crypto.randomUUID(), points: 30,
        maturesAt: Date.now() - 1, expiresAt: Date.now() + DAY, day: Math.floor(Date.now() / DAY), policyVersion: 1, ...change,
      })
    })
    expect(await t.run(ctx => juryScore(moderationReads(ctx), juror._id))).toBe(20)
    await t.run(ctx => ctx.db.patch(f.revisionId, { quarantined: false }))
    expect(await t.run(ctx => juryScore(moderationReads(ctx), juror._id))).toBe(35)
  })

  it("continues the installed candidate order without selecting a partial population", async () => {
    const t = setup(), f = await fixture(t), candidates: { agentId: Id<"agents">; ownerId: string; weight: number }[] = []
    for (let n = 0; n < 15; n++) {
      const juror = await agent(t, `ordered-juror-${n}`)
      candidates.push({ agentId: juror._id, ownerId: juror.ownerId!, weight: 1 })
      if (n < 12) await t.run(async ctx => ctx.db.patch((await ctx.db.query("approvedOwners").withIndex("by_owner", q => q.eq("ownerId", juror.ownerId!)).unique())!._id, { approved: false }))
    }
    const { caseId } = await report(t, f)
    await t.mutation(internal.governance.installDraw, { caseId, candidates, seed: "fixed-fixture-order" })
    expect(await t.run(ctx => ctx.db.get(caseId))).toMatchObject({ candidateCursor: 12, roundJobPending: true })
    await t.mutation(internal.governance.continueCase, { caseId, generation: 1 })
    const seats = await t.run(ctx => ctx.db.query("committeeSeats").withIndex("by_case", q => q.eq("caseId", caseId)).collect())
    expect(seats.map(seat => seat.agentId)).toEqual(candidates.slice(12).map(candidate => candidate.agentId))
    expect((await t.run(ctx => ctx.db.get(caseId)))?.drawSeed).toBe("fixed-fixture-order")
  })

  it("dispatches recovery per case and makes stale continuation delivery harmless", async () => {
    const t = setup(), f = await fixture(t), ids: Id<"moderationCases">[] = []
    for (let n = 0; n < 3; n++) ids.push(await t.run(ctx => createCase(ctx, {
      kind: "admission", reason: "spam", targetKind: "agent", targetId: f.author._id, subjectId: f.author._id,
      dedupeKey: `recover-${n}`, evidence: "Harmless recovery fixture", provenance: "Fixture",
    })))
    await t.run(async ctx => {
      for (const id of ids) await ctx.db.patch(id, { state: "voting", deadline: Date.now() - 3 * 60000 })
    })
    await t.mutation(internal.governance.recover, { state: "voting" })
    vi.setSystemTime(Date.now() + 5 * 60000 + 1)
    await t.mutation(internal.governance.recover, { state: "voting" })
    for (const caseId of ids) {
      expect(await t.run(ctx => ctx.db.get(caseId))).toMatchObject({ state: "voting", roundJobPending: true, roundJobVersion: 2 })
      await t.mutation(internal.governance.continueCase, { caseId, generation: 1 })
      expect((await t.run(ctx => ctx.db.get(caseId)))?.state).toBe("voting")
      await t.mutation(internal.governance.continueCase, { caseId, generation: 2 })
      expect((await t.run(ctx => ctx.db.get(caseId)))?.state).toBe("escalated")
      await t.run(ctx => ctx.db.patch(caseId, { state: "resolved", decision: "reject" }))
      await t.mutation(internal.governance.continueCase, { caseId, generation: 2 })
      expect((await t.run(ctx => ctx.db.get(caseId)))?.state).toBe("resolved")
    }
  })

  it("rechecks late author conflicts at closure without shrinking the frozen denominator", async () => {
    const t = setup(), f = await fixture(t), jurors = []
    for (let n = 0; n < 3; n++) jurors.push(await agent(t, `closing-juror-${n}`))
    vi.setSystemTime(Date.now() + 15 * DAY)
    for (const juror of jurors) await mature(t, juror)
    const { caseId } = await report(t, f)
    await t.mutation(internal.governance.installDraw, { caseId, seed: "closure-fixture", candidates: jurors.map(juror => ({ agentId: juror._id, ownerId: juror.ownerId!, weight: 1 })) })
    for (const juror of jurors) await t.run(ctx => respond(ctx, juror, caseId, true))
    for (const juror of jurors) await t.run(ctx => ballot(ctx, juror, caseId, 1, "accept", "Harmless closure fixture."))
    for (const juror of jurors.slice(0, 2)) await longHistory(t, f.id, await agent(t, juror.ownerId!), 1)
    const c = (await t.run(ctx => ctx.db.get(caseId)))!
    vi.setSystemTime(c.deadline + 1)
    await t.run(ctx => closeRound(ctx, c))
    expect(await t.run(ctx => ctx.db.get(caseId))).toMatchObject({ state: "escalated" })
    expect(await t.run(ctx => ctx.db.query("moderationCases").withIndex("by_parent", q => q.eq("parentCaseId", caseId)).collect())).toEqual([])
  })

  it("escalates appeals with excessive legacy jurors and releases their tasks in bounded pages", async () => {
    const t = setup(), f = await fixture(t)
    const { caseId } = await report(t, f)
    const tasks: Id<"tasks">[] = []
    await t.run(async ctx => {
      await ctx.db.patch(caseId, { kind: "conduct", state: "resolved", decision: "accept", resolvedAt: Date.now() })
      for (let n = 0; n < 80; n++) {
        const taskId = await ctx.db.insert("tasks", { committeeCaseId: caseId, type: "committee_review", topic: "moderation",
          title: "Legacy jury fixture", description: "Safe fixture", dedupeKey: `legacy-seat-${n}`, status: "open", issueOpen: false, random: 0, updatedAt: Date.now() })
        tasks.push(taskId)
        await ctx.db.insert("committeeSeats", { caseId, agentId: f.reporter._id, ownerId: `legacy-owner-${n}`, taskId,
          weight: 1, accepted: false, declined: true })
      }
    })
    const original = (await t.run(ctx => ctx.db.get(caseId)))!
    const appeal = await t.run(ctx => openAppeal(ctx, f.author.ownerId!, original, "Harmless legacy appeal fixture."))
    expect(await t.run(ctx => ctx.db.get(appeal.caseId))).toMatchObject({ state: "escalated", authorshipState: "incomplete" })
    await t.run(ctx => releaseSeats(ctx, original))
    // Let the bounded release continuations finish; draw actions observe that
    // their source cases are already resolved/escalated and cannot reroll them.
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    for (const id of tasks) expect((await t.run(ctx => ctx.db.get(id)))?.status).toBe("completed")
  })
})
