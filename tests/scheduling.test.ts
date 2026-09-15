/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import { makeFunctionReference, type CronJob } from "convex/server"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { requestBatch } from "../convex/lib/batches"
import { queueIndex } from "../convex/lib/indexQueue"
import { armLease } from "../convex/lib/leaseTimers"
import { armCaseDeadline } from "../convex/moderation/timers"
import { renewWork } from "../convex/ops/tasks"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest({ schema, modules, transactionLimits: true })
type Test = ReturnType<typeof setup>
const MINUTE = 60_000
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-09-15T00:00:00Z"))
  vi.stubEnv("INDEXNOW_KEY", "")
  vi.stubEnv("SCHEDULING_LEGACY_RECOVERY", "false")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const batch = (t: Test, name: "matching" | "indexnow") =>
  t.run((ctx) =>
    ctx.db
      .query("maintenanceBatches")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique()
  )
async function advance(t: Test, milliseconds: number) {
  vi.advanceTimersByTime(milliseconds)
  await t.finishInProgressScheduledFunctions()
}
async function drainMatching(t: Test) {
  for (let i = 0; i < 200; i++) {
    if (!(await batch(t, "matching"))?.scheduledId) return
    await advance(t, 100)
  }
  throw new Error("Matching did not become idle within its bounded pass")
}
const agent = (t: Test, slug: string) =>
  t.run((ctx) =>
    ctx.db.insert("agents", {
      name: slug,
      slug,
      role: "editor",
      bio: "Fixture",
      capabilities: [],
      topics: [],
      blocked: false,
      contributionCount: 0,
      reviewCount: 0,
      updatedAt: Date.now(),
    })
  )
const task = (t: Test) =>
  t.run((ctx) =>
    ctx.db.insert("tasks", {
      type: "maintenance",
      topic: "fixture",
      title: "Fixture",
      description: "Synthetic work",
      dedupeKey: crypto.randomUUID(),
      status: "open",
      random: 0.5,
      issueOpen: false,
      updatedAt: Date.now(),
    })
  )
async function waiting(
  t: Test,
  agentId: Id<"agents">,
  types = ["maintenance"],
  arm = true
) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("assignments", {
      agentId,
      types,
      topics: [],
      budgetMinutes: 60,
      status: "waiting",
      expiresAt: Date.now() + 60 * MINUTE,
      maxExpiresAt: Date.now() + 60 * MINUTE,
    })
    if (arm) await armLease(ctx, (await ctx.db.get(id))!)
    return id
  })
}
async function votingCase(t: Test, armed = true) {
  const subjectId = await agent(t, crypto.randomUUID())
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("moderationCases", {
      kind: "conduct",
      reason: "prompt_injection",
      targetKind: "report",
      targetId: "fixture",
      subjectId,
      dedupeKey: crypto.randomUUID(),
      policyVersion: 1,
      state: "voting",
      public: false,
      seatingUntil: Date.now() - MINUTE,
      deadline: Date.now() + 10 * MINUTE,
      excludedOwners: [],
      excludedAgents: [],
      candidates: [],
      candidateCursor: 0,
      rosterDay: 0,
    })
    if (armed) await armCaseDeadline(ctx, id)
    return id
  })
}

describe("idle scheduling budget", () => {
  it("executes a day of every configured root and child below the 20k/month idle budget", async () => {
    const t = setup()
    vi.spyOn(console, "info").mockImplementation(() => {})
    const { default: crons } = await import("../convex/crons")
    // Convex's runtime export is intentionally absent from its public typings.
    const jobs = Object.values(
      JSON.parse((crons as unknown as { export(): string }).export()) as Record<
        string,
        CronJob
      >
    )
    const invocations: { minute: number; name: string }[] = []
    for (const job of jobs) {
      const s = job.schedule
      if (s.type === "interval") {
        const interval =
          "seconds" in s
            ? s.seconds / 60
            : "minutes" in s
              ? s.minutes
              : s.hours * 60
        expect(interval).toBeGreaterThanOrEqual(5)
        for (let minute = 0; minute < 1440; minute += interval)
          invocations.push({ minute, name: job.name })
      } else if (s.type === "hourly") {
        for (let hour = 0; hour < 24; hour++)
          invocations.push({
            minute: hour * 60 + (s.minuteUTC ?? 0),
            name: job.name,
          })
      } else if (s.type === "daily")
        invocations.push({
          minute: s.hourUTC * 60 + (s.minuteUTC ?? 0),
          name: job.name,
        })
      else throw new Error(`Account for newly configured schedule: ${s.type}`)
    }
    for (const invocation of invocations.sort((a, b) => a.minute - b.minute)) {
      vi.setSystemTime(
        new Date("2026-09-15T00:00:00Z").getTime() + invocation.minute * MINUTE
      )
      await t.mutation(makeFunctionReference<"mutation">(invocation.name), {})
      await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    }
    const children = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(children.every((call) => call.state.kind === "success")).toBe(true)
    expect(
      invocations.filter((call) => call.name === "maintenance:watchdog")
    ).toHaveLength(288)
    expect(invocations.length + children.length).toBe(461)
    expect((invocations.length + children.length) * 30).toBeLessThan(20_000)
    expect(await t.mutation(internal.maintenance.watchdog, {})).toEqual({
      dispatched: 0,
    })
  })
})

describe("coalesced matching and durable leases", () => {
  it("coalesces a burst, preserves FIFO beyond the first page, and stops rescanning unchanged work", async () => {
    const t = setup()
    const incompatible = await agent(t, "incompatible")
    for (let i = 0; i < 65; i++) await waiting(t, incompatible, ["patrol"])
    const oldest = await waiting(t, await agent(t, "oldest"))
    const newer = await waiting(t, await agent(t, "newer"))
    const taskId = await task(t)
    await t.run((ctx) => requestBatch(ctx, "matching"))
    const signal = () =>
      t.run((ctx) =>
        ctx.db
          .query("maintenanceSignals")
          .withIndex("by_name", (q) => q.eq("name", "matching"))
          .unique()
      )
    const signaled = await signal()
    for (let i = 0; i < 100; i++)
      await t.run((ctx) => requestBatch(ctx, "matching"))
    expect(await signal()).toEqual(signaled)
    expect((await batch(t, "matching"))?.generation).toBe(1)
    await advance(t, 100)
    const started = await signal()
    await advance(t, 100)
    expect(await signal()).toEqual(started)
    await drainMatching(t)
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.assignmentId).toBe(
      oldest
    )
    expect((await t.run((ctx) => ctx.db.get(newer)))?.status).toBe("waiting")
    const generation = (await batch(t, "matching"))!.generation
    await advance(t, MINUTE)
    expect((await batch(t, "matching"))?.generation).toBe(generation)
    expect((await batch(t, "matching"))?.scheduledId).toBeUndefined()
  })

  it("does another pass when new work arrives behind its cursor", async () => {
    const t = setup()
    const ticket = await waiting(t, await agent(t, "arriving"))
    await t.run((ctx) => requestBatch(ctx, "matching"))
    // An empty first half of a pass is completed before the task is published.
    await advance(t, 100)
    const taskId = await task(t)
    await t.run((ctx) => requestBatch(ctx, "matching"))
    await drainMatching(t)
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.assignmentId).toBe(
      ticket
    )
  })

  it("keeps one timer across renewals, re-arms at the old expiry, and expires without a cron", async () => {
    const t = setup(),
      worker = await agent(t, "renewed"),
      taskId = await task(t)
    const ticket = await waiting(t, worker)
    await t.run((ctx) => requestBatch(ctx, "matching"))
    await drainMatching(t)
    const original = (await t.run((ctx) => ctx.db.get(ticket)))!
    await advance(t, 5 * MINUTE)
    for (let i = 0; i < 5; i++)
      await t.run(async (ctx) =>
        renewWork(ctx, (await ctx.db.get(worker))!, { assignmentId: ticket })
      )
    const renewed = (await t.run((ctx) => ctx.db.get(ticket)))!
    expect(renewed.expiryScheduledId).toBe(original.expiryScheduledId)
    expect(renewed.expiresAt).toBeGreaterThan(original.expiresAt)
    await advance(t, original.expiresAt - Date.now() + 1)
    const rearmed = (await t.run((ctx) => ctx.db.get(ticket)))!
    expect(rearmed.status).toBe("active")
    expect(rearmed.expiryGeneration).toBe(original.expiryGeneration! + 1)
    await t.mutation(internal.work.expireLease, {
      assignmentId: ticket,
      generation: original.expiryGeneration!,
    })
    expect((await t.run((ctx) => ctx.db.get(ticket)))?.status).toBe("active")
    await advance(t, renewed.expiresAt - Date.now() + 1)
    expect((await t.run((ctx) => ctx.db.get(ticket)))?.status).toBe("expired")
    expect((await t.run((ctx) => ctx.db.get(taskId)))?.status).toBe("open")
  })

  it("recovers a canceled matching wake once, retaining its generation guard", async () => {
    const t = setup()
    await t.run((ctx) => requestBatch(ctx, "matching"))
    const before = (await batch(t, "matching"))!
    await t.run((ctx) => ctx.scheduler.cancel(before.scheduledId!))
    vi.setSystemTime(Date.now() + 5 * MINUTE)
    expect(await t.mutation(internal.maintenance.watchdog, {})).toEqual({
      dispatched: 1,
    })
    const recovered = (await batch(t, "matching"))!
    await t.mutation(internal.work.matchWaiting, {
      generation: before.generation,
    })
    expect((await batch(t, "matching"))?.scheduledId).toBe(
      recovered.scheduledId
    )
    expect(await t.mutation(internal.maintenance.watchdog, {})).toEqual({
      dispatched: 0,
    })
    await drainMatching(t)
  })
})

describe("IndexNow batch outcomes", () => {
  function enabled() {
    vi.stubEnv("INDEXNOW_KEY", "fixture")
    vi.stubEnv("SITE_URL", "https://fixture.example")
  }
  it("drains more than one page through bounded external actions", async () => {
    enabled()
    const t = setup()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 200 }))
    for (let i = 0; i < 205; i++)
      await t.run((ctx) => queueIndex(ctx, `https://fixture.example/wiki/${i}`))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(
      fetch.mock.calls.map(
        ([, options]) => JSON.parse(options!.body as string).urlList.length
      )
    ).toEqual([100, 100, 5])
    expect(
      (
        await t.run((ctx) => ctx.db.query("indexNotifications").collect())
      ).every((row) => row.status === "sent" && row.attempts === 1)
    ).toBe(true)
    expect((await batch(t, "indexnow"))?.scheduledId).toBeUndefined()
  })

  it("backs off HTTP failures and stops after four attempts", async () => {
    enabled()
    const t = setup()
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("", { status: 503 }))
    await t.run((ctx) =>
      queueIndex(ctx, "https://fixture.example/wiki/unavailable")
    )
    const started = Date.now()
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(Date.now() - started).toBeGreaterThanOrEqual(
      60_000 + 120_000 + 240_000 + 480_000
    )
    expect(
      await t.run((ctx) => ctx.db.query("indexNotifications").first())
    ).toMatchObject({ status: "failed", attempts: 4 })
    expect((await batch(t, "indexnow"))?.scheduledId).toBeUndefined()
  })

  it("does not postpone the first flush, or acknowledge a newer same-millisecond edit", async () => {
    enabled()
    const t = setup(),
      url = "https://fixture.example/wiki/test"
    await t.run((ctx) => queueIndex(ctx, url))
    const first = (await batch(t, "indexnow"))!
    for (let i = 0; i < 100; i++) await t.run((ctx) => queueIndex(ctx, url))
    expect((await batch(t, "indexnow"))?.scheduledId).toBe(first.scheduledId)
    expect((await batch(t, "indexnow"))?.nextAt).toBe(first.nextAt)
    const sent = (await t.run((ctx) =>
      ctx.db.query("indexNotifications").first()
    ))!
    await t.mutation(internal.indexing.flush, { generation: first.generation })
    await t.run((ctx) => queueIndex(ctx, url))
    await t.mutation(internal.indexing.complete, {
      generation: first.generation,
      rows: [
        {
          id: sent._id,
          url,
          version: sent.version!,
          updatedAt: sent.updatedAt,
        },
      ],
      success: true,
      terminal: false,
    })
    const current = (await t.run((ctx) => ctx.db.get(sent._id)))!
    expect(current.status).toBe("pending")
    expect(current.version).toBe(sent.version! + 1)
    expect(current.updatedAt).toBeGreaterThan(sent.updatedAt)
    expect((await batch(t, "indexnow"))?.generation).toBe(first.generation + 1)
  })

  it("bounds crash retries as well as HTTP failures and recovers without duplicate in-flight actions", async () => {
    enabled()
    const t = setup(),
      url = "https://fixture.example/wiki/retry"
    await t.run((ctx) => queueIndex(ctx, url))
    for (let attempt = 1; attempt <= 4; attempt++) {
      const current = (await batch(t, "indexnow"))!
      await t.mutation(internal.indexing.flush, {
        generation: current.generation,
      })
      const action = (await batch(t, "indexnow"))!
      vi.setSystemTime(Date.now() + 5 * MINUTE)
      // A still-pending action must not be duplicated just because it is late.
      expect(await t.mutation(internal.maintenance.watchdog, {})).toEqual({
        dispatched: 0,
      })
      await t.run((ctx) => ctx.scheduler.cancel(action.scheduledId!))
      expect(await t.mutation(internal.maintenance.watchdog, {})).toEqual({
        dispatched: 1,
      })
      expect(
        (await t.run((ctx) => ctx.db.query("indexNotifications").first()))
          ?.attempts
      ).toBe(attempt)
    }
    await t.mutation(internal.indexing.flush, {
      generation: (await batch(t, "indexnow"))!.generation,
    })
    expect(
      (await t.run((ctx) => ctx.db.query("indexNotifications").first()))?.status
    ).toBe("failed")
    expect((await batch(t, "indexnow"))?.scheduledId).toBeUndefined()
  })
})

describe("case deadlines and rollout", () => {
  it("retains the full voting window and cancels terminal timers", async () => {
    const t = setup(),
      caseId = await votingCase(t)
    const before = (await t.run((ctx) => ctx.db.get(caseId)))!
    await t.mutation(internal.governance.continueCase, {
      caseId,
      generation: before.roundJobVersion!,
    })
    expect((await t.run((ctx) => ctx.db.get(caseId)))?.state).toBe("voting")
    const current = (await t.run((ctx) => ctx.db.get(caseId)))!
    await t.mutation(internal.governance.continueCase, {
      caseId,
      generation: before.roundJobVersion!,
    })
    expect((await t.run((ctx) => ctx.db.get(caseId)))?.roundJobVersion).toBe(
      current.roundJobVersion
    )
    await advance(t, before.deadline - Date.now())
    const closed = (await t.run((ctx) => ctx.db.get(caseId)))!
    expect(closed.state).toBe("escalated")
    expect(closed.roundJobPending).toBe(false)
    expect(closed.roundRecoveryId).toBeUndefined()
    expect(closed.roundJobScheduledId).toBeUndefined()
  })

  it("recovers a failed deadline wake inside the grace, but does not silently extend a late window", async () => {
    const t = setup(),
      caseId = await votingCase(t)
    const before = (await t.run((ctx) => ctx.db.get(caseId)))!
    await t.run((ctx) => ctx.scheduler.cancel(before.roundJobScheduledId!))
    await advance(t, before.deadline - Date.now() + MINUTE)
    await advance(t, 1)
    expect((await t.run((ctx) => ctx.db.get(caseId)))?.state).toBe("escalated")
    expect(
      (await t.run((ctx) => ctx.db.get(caseId)))?.decisionReason
    ).not.toContain("did not complete by the deadline")
    const lateId = await votingCase(t),
      late = (await t.run((ctx) => ctx.db.get(lateId)))!
    vi.setSystemTime(late.deadline + 2 * MINUTE + 1)
    await t.mutation(internal.governance.continueCase, {
      caseId: lateId,
      generation: late.roundJobVersion!,
    })
    expect(
      (await t.run((ctx) => ctx.db.get(lateId)))?.decisionReason
    ).toContain("did not complete by the deadline")
  })

  it("re-arms legacy rows in bounded pages before the cron cutover", async () => {
    const t = setup(),
      worker = await agent(t, "legacy")
    for (let i = 0; i < 70; i++)
      await waiting(t, worker, ["maintenance"], false)
    for (let i = 0; i < 35; i++) await votingCase(t, false)
    expect((await t.query(internal.maintenance.status, {})).timersArmed).toBe(
      false
    )
    expect(await t.mutation(internal.maintenance.rearm, {})).toEqual({
      armed: 62,
      more: true,
    })
    for (
      let i = 0;
      i < 10 && !(await t.query(internal.maintenance.status, {})).timersArmed;
      i++
    )
      await advance(t, 100)
    expect((await t.query(internal.maintenance.status, {})).timersArmed).toBe(
      true
    )
    expect(await t.mutation(internal.maintenance.rearm, {})).toEqual({
      armed: 0,
      more: false,
    })
  })
})
