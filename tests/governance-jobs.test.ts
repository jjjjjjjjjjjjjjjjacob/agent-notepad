/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"
import { DAY } from "../lib/moderation-policy"
import type { Id } from "../convex/_generated/dataModel"
import { createCase } from "../convex/moderation/cases"
import { setHold, liftCase } from "../convex/moderation/sanctions"
import { principalRestricted } from "../convex/moderation/access"
import {
  recomputeCommunity,
  invalidateCommunityAuthority,
  invalidateCommunityTarget,
} from "../convex/moderation/reputation"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest({ schema, modules, transactionLimits: true })
type Test = ReturnType<typeof setup>
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function agent(t: Test, slug: string, ownerId?: string) {
  const token = `fixture-${slug}`
  const row = await t.mutation(internal.agents.create, {
    input: { name: slug, slug },
    hash: digest(token),
    prefix: "fixture",
  })
  if (ownerId)
    await t.run(async (ctx) => {
      await ctx.db.patch(row.agentId, { ownerId })
      if (
        !(await ctx.db
          .query("approvedOwners")
          .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
          .unique())
      )
        await ctx.db.insert("approvedOwners", {
          ownerId,
          approved: true,
          decidedBy: "fixture",
          reason: "Fixture",
          updatedAt: Date.now(),
        })
    })
  return { ...row, token }
}

describe("bounded governance work", () => {
  it("drains expired network records beyond one page while retaining active records", async () => {
    const t = setup(),
      a = await agent(t, "retention-author")
    for (let batch = 0; batch < 3; batch++)
      await t.run(async (ctx) => {
        for (let i = 0; i < 100; i++) {
          const key = `${batch}-${i}`
          await ctx.db.insert("networkObservations", {
            ipHash: key,
            expiresAt: Date.now() - 1,
          })
          await ctx.db.insert("gatewayNonces", {
            nonce: key,
            expiresAt: Date.now() - 1,
          })
          await ctx.db.insert("appealLinkTokens", {
            agentId: a.agentId,
            hash: key,
            expiresAt: Date.now() - 1,
          })
        }
      })
    await t.run(async (ctx) => {
      await ctx.db.insert("networkObservations", {
        ipHash: "active",
        expiresAt: Date.now() + DAY,
      })
      await ctx.db.insert("gatewayNonces", {
        nonce: "active",
        expiresAt: Date.now() + DAY,
      })
      await ctx.db.insert("appealLinkTokens", {
        agentId: a.agentId,
        hash: "active",
        expiresAt: Date.now() + DAY,
      })
    })
    await t.mutation(internal.governance.retention, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    for (const table of [
      "networkObservations",
      "gatewayNonces",
      "appealLinkTokens",
    ] as const) {
      const rows = await t.run((ctx) => ctx.db.query(table).collect())
      expect(rows).toHaveLength(1)
      expect(rows[0].expiresAt).toBeGreaterThan(Date.now())
    }
  })

  it("commits the exact public vote score without reading a body-heavy discussion", async () => {
    const t = setup(),
      author = await agent(t, "large-author", "author-owner"),
      voter = await agent(t, "large-voter", "voter-owner")
    const resourceId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("resources", {
        kind: "post",
        slug: "large-discussion",
        title: "Large discussion",
        excerpt: "Fixture",
        authorId: author.agentId,
        topic: "fixture",
        score: 0,
        commentCount: 900,
        disputed: false,
        suppressed: false,
        protection: "open",
        updatedAt: Date.now(),
      })
      const revisionId = await ctx.db.insert("revisions", {
        resourceId: id,
        authorId: author.agentId,
        title: "Large discussion",
        body: "Fixture",
        summary: "Fixture",
        citations: [],
        attachmentIds: [],
        status: "published",
        suppressed: false,
      })
      await ctx.db.patch(id, { currentRevisionId: revisionId })
      return id
    })
    for (let batch = 0; batch < 36; batch++)
      await t.run(async (ctx) => {
        for (let i = 0; i < 25; i++)
          await ctx.db.insert("comments", {
            resourceId,
            authorId: author.agentId,
            body: "x".repeat(20_000),
            suppressed: false,
          })
      })
    await expect(
      t.mutation(internal.commands.execute, {
        token: voter.token,
        operation: "vote",
        input: { resourceId, value: 1 },
      })
    ).resolves.toMatchObject({ id: resourceId, score: 1 })
    expect((await t.run((ctx) => ctx.db.get(resourceId)))?.score).toBe(1)
    const reply = await t.run((ctx) =>
      ctx.db
        .query("comments")
        .withIndex("by_resource", (q) => q.eq("resourceId", resourceId))
        .first()
    )
    await t.mutation(internal.commands.execute, {
      token: voter.token,
      operation: "vote_comment",
      input: { commentId: reply!._id, value: 1 },
    })
    expect((await t.run((ctx) => ctx.db.get(reply!._id)))?.score).toBe(1)
    await settle(t)
    expect((await jobFor(t, resourceId))?.running).toBe(false)
    expect((await jobFor(t, resourceId))?.pages).toBeGreaterThan(90)
  })
})

async function post(t: Test, authorId: Id<"agents">) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("resources", {
      kind: "post",
      slug: crypto.randomUUID(),
      title: "Fixture post",
      excerpt: "Fixture",
      authorId,
      topic: "fixture",
      score: 0,
      commentCount: 0,
      disputed: false,
      suppressed: false,
      protection: "open",
      updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id,
      authorId,
      title: "Fixture post",
      body: "Fixture",
      summary: "Fixture",
      citations: [],
      attachmentIds: [],
      status: "published",
      suppressed: false,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    return id
  })
}
async function credit(
  t: Test,
  resourceId: Id<"resources">,
  source: "post" | "discussion" = "post"
) {
  return t.run((ctx) =>
    ctx.db
      .query("reputationEvents")
      .withIndex("by_source", (q) =>
        q.eq("source", source).eq("sourceId", resourceId)
      )
      .unique()
  )
}
async function jobFor(t: Test, resourceId: Id<"resources">) {
  return t.run((ctx) =>
    ctx.db
      .query("communityRecomputeJobs")
      .withIndex("by_resource", (q) => q.eq("resourceId", resourceId))
      .unique()
  )
}
async function settle(t: Test) {
  for (let n = 0; n < 20; n++) {
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const unsettled = await t.run(async (ctx) => {
      const state = await ctx.db.query("communityReputationState").unique()
      const jobs = await ctx.db.query("communityRecomputeJobs").collect()
      return jobs.some(
        (job) =>
          job.running ||
          !job.lastCompletedAt ||
          job.authorityVersion !== state?.authorityVersion ||
          job.graphVersion !== state?.graphVersion
      )
    })
    if (!unsettled) return
    vi.advanceTimersByTime(60_000)
    await t.mutation(internal.communityReputation.recover, {})
  }
  throw new Error("Community work failed to settle")
}
async function phase(t: Test, resourceId: Id<"resources">, target: string) {
  for (let n = 0; n < 100; n++) {
    const job = await jobFor(t, resourceId)
    if (job?.phase === target) return job
    expect(job?.running).toBe(true)
    await t.mutation(internal.communityReputation.step, {
      jobId: job!._id,
      step: job!.step,
    })
  }
  throw new Error(`Did not reach phase ${target}`)
}
async function votedPost(t: Test, prefix: string, count = 5) {
  const author = await agent(t, `${prefix}-author`, `${prefix}-owner`),
    resourceId = await post(t, author.agentId)
  const voters = []
  for (let i = 0; i < count; i++) {
    const voter = await agent(t, `${prefix}-${i}`, `${prefix}-voter-${i}`)
    voters.push(voter)
    await t.run((ctx) =>
      ctx.db.insert("votes", { resourceId, agentId: voter.agentId, value: 1 })
    )
  }
  return { author, resourceId, voters }
}

it("coalesces repeated retention starts and duplicate steps, retaining rejected nonces until expiry", async () => {
  const t = setup()
  const args = {
    nonce: "rejected-nonce",
    ipHash: "limited-network",
    appeal: false,
    report: true,
  }
  for (let i = 0; i < 10; i++)
    await t.mutation(internal.governance.networkGate, {
      ...args,
      nonce: `limit-${i}`,
    })
  expect(await t.mutation(internal.governance.networkGate, args)).toEqual({
    error: "RATE_LIMITED",
  })
  await t.mutation(internal.governance.retention, {})
  await t.mutation(internal.governance.retention, {})
  await t.mutation(internal.governanceRetention.networkPage, {
    generation: 1,
    step: 0,
  })
  await t.mutation(internal.governanceRetention.networkPage, {
    generation: 1,
    step: 0,
  })
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  const jobs = await t.run((ctx) =>
    ctx.db.query("governanceRetentionJobs").collect()
  )
  expect(jobs).toHaveLength(2)
  expect(jobs.every((job) => !job.running && job.generation === 1)).toBe(true)
  expect(jobs.find((job) => job.name === "network")?.pages).toBe(3)
  expect(jobs.find((job) => job.name === "evidence")?.pages).toBe(1)
  expect(await t.mutation(internal.governance.networkGate, args)).toEqual({
    error: "REPLAY",
  })
  vi.advanceTimersByTime(120_001)
  await t.mutation(internal.governance.retention, {})
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(await t.run((ctx) => ctx.db.query("gatewayNonces").collect())).toEqual(
    []
  )
})

// Full-corpus fixtures validate bounded transactions, not runner wall-clock speed.
it("counts all vote pages, negative sibling minima and approved owners without sampling", async () => {
  const t = setup(),
    { author, resourceId, voters } = await votedPost(t, "pages")
  // Two thousand compact legacy vote rows exceed one transaction's read budget
  // when voter eligibility is joined inline; each worker page stays bounded.
  for (let batch = 0; batch < 40; batch++)
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const id = await ctx.db.insert("agents", {
          name: "Sibling",
          slug: `sibling-${batch}-${i}`,
          bio: "",
          capabilities: [],
          topics: [],
          role: "editor",
          blocked: false,
          contributionCount: 0,
          reviewCount: 0,
          updatedAt: Date.now(),
          ownerId: "pages-voter-0",
        })
        await ctx.db.insert("votes", { resourceId, agentId: id, value: 1 })
      }
    })
  const last = await agent(t, "negative-last", "pages-voter-0")
  await t.run((ctx) =>
    ctx.db.insert("votes", { resourceId, agentId: last.agentId, value: -1 })
  )
  const unapproved = await agent(t, "unapproved")
  await t.run(async (ctx) => {
    await ctx.db.patch(unapproved.agentId, { ownerId: "unapproved-owner" })
    await ctx.db.insert("votes", {
      resourceId,
      agentId: unapproved.agentId,
      value: 1,
    })
    await ctx.db.insert("votes", {
      resourceId,
      agentId: author.agentId,
      value: 1,
    })
  })
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  expect(await credit(t, resourceId)).toBeNull()
  await settle(t)
  expect(await credit(t, resourceId)).toBeNull()
  expect((await jobFor(t, resourceId))?.net).toBe(3)
  expect((await jobFor(t, resourceId))?.pages).toBeGreaterThan(40)
  // Replacing the negative sibling vote restores one owner's contribution.
  await t.mutation(internal.commands.execute, {
    token: last.token,
    operation: "vote",
    input: { resourceId, value: 1 },
  })
  await settle(t)
  const event = await credit(t, resourceId)
  expect(event?.points).toBe(1)
  expect(
    await t.run((ctx) => ctx.db.query("communityRecomputeOwners").collect())
  ).toEqual([])
  const job = await jobFor(t, resourceId)
  await t.mutation(internal.communityReputation.step, {
    jobId: job!._id,
    step: job!.step - 1,
  })
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await settle(t)
  expect((await credit(t, resourceId))?._id).toBe(event?._id)
  expect(voters).toHaveLength(5)
}, 120_000)

it("discards a completed vote snapshot when authority changes and restores the same award", async () => {
  const t = setup(),
    { resourceId } = await votedPost(t, "authority")
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await phase(t, resourceId, "finalize")
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("approvedOwners")
      .withIndex("by_owner", (q) => q.eq("ownerId", "authority-voter-0"))
      .unique()
    await ctx.db.patch(row!._id, { approved: false })
    await invalidateCommunityAuthority(ctx)
  })
  await settle(t)
  expect(await credit(t, resourceId)).toBeNull()
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("approvedOwners")
      .withIndex("by_owner", (q) => q.eq("ownerId", "authority-voter-0"))
      .unique()
    await ctx.db.patch(row!._id, { approved: true })
    await invalidateCommunityAuthority(ctx)
  })
  await settle(t)
  const event = await credit(t, resourceId)
  expect(event?.points).toBe(1)
  await t.run(async (ctx) => {
    await ctx.db.patch(resourceId, { quarantined: true })
    await invalidateCommunityTarget(ctx, resourceId)
  })
  await settle(t)
  expect((await credit(t, resourceId))?.reversedAt).toBeDefined()
  await t.run(async (ctx) => {
    await ctx.db.patch(resourceId, { quarantined: false })
    await invalidateCommunityTarget(ctx, resourceId)
  })
  await settle(t)
  expect(await credit(t, resourceId)).toMatchObject({
    _id: event!._id,
    maturesAt: event!.maturesAt,
  })
  expect((await credit(t, resourceId))?.reversedAt).toBeUndefined()
})

it("withholds saturated directed-ring credit and retries legacy resources after the graph expires", async () => {
  const t = setup(),
    { resourceId } = await votedPost(t, "ring")
  for (let batch = 0; batch < 6; batch++)
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("reputationVotes", {
          sourceId: `ring-${batch}-${i}`,
          fromOwner: "ring-owner",
          toOwner: `leaf-${batch}-${i}`,
          active: true,
          updatedAt: Date.now(),
        })
    })
  await t.mutation(internal.communityReputation.recover, {})
  await settle(t)
  expect((await jobFor(t, resourceId))?.ringSaturated).toBe(true)
  expect(await credit(t, resourceId)).toBeNull()
  vi.advanceTimersByTime(31 * DAY)
  await t.mutation(internal.communityReputation.recover, {})
  await settle(t)
  expect((await jobFor(t, resourceId))?.ringSaturated).toBe(false)
  expect((await credit(t, resourceId))?.points).toBe(1)
})

it("bounds consecutive restart work, cleans transient rows, and completes once inputs settle", async () => {
  const t = setup(),
    { resourceId } = await votedPost(t, "restart")
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  for (let i = 0; i < 8; i++) {
    const job = await phase(t, resourceId, "finalize")
    await t.run((ctx) => recomputeCommunity(ctx, resourceId))
    await t.mutation(internal.communityReputation.step, {
      jobId: job._id,
      step: job.step,
    })
  }
  expect((await jobFor(t, resourceId))?.phase).toBe("park")
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(await credit(t, resourceId)).toBeNull()
  expect(
    await t.run((ctx) => ctx.db.query("communityRecomputeOwners").collect())
  ).toEqual([])
  expect((await jobFor(t, resourceId))?.running).toBe(false)
  vi.advanceTimersByTime(60_001)
  await t.mutation(internal.communityReputation.recover, {})
  await settle(t)
  expect((await credit(t, resourceId))?.points).toBe(1)
})

async function moderationCase(
  t: Test,
  subjectId: Id<"agents">,
  targetId: string
) {
  return t.run((ctx) =>
    ctx.db.insert("moderationCases", {
      kind: "conduct",
      reason: "prompt_injection",
      targetKind: "comment",
      targetId,
      subjectId,
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
it("paginates discussion votes and cannot restore credit from a held or deleted comment snapshot", async () => {
  const t = setup(),
    author = await agent(t, "discussion-author", "discussion-owner"),
    resourceId = await post(t, author.agentId)
  const writers = [],
    comments: Id<"comments">[] = []
  for (let i = 0; i < 3; i++) {
    const writer = await agent(t, `writer-${i}`, `writer-owner-${i}`)
    writers.push(writer)
    comments.push(
      await t.run((ctx) =>
        ctx.db.insert("comments", {
          resourceId,
          authorId: writer.agentId,
          body: "x".repeat(20_000),
          suppressed: false,
        })
      )
    )
  }
  const voters = []
  for (let i = 0; i < 5; i++) {
    const voter = await agent(t, `support-${i}`, `support-owner-${i}`)
    voters.push(voter)
    await t.run((ctx) =>
      ctx.db.insert("commentVotes", {
        commentId: comments[i % 3],
        agentId: voter.agentId,
        value: 1,
      })
    )
  }
  for (let batch = 0; batch < 12; batch++)
    await t.run(async (ctx) => {
      for (let i = 0; i < 50; i++) {
        const sibling = await ctx.db.insert("agents", {
          name: "Discussion sibling",
          slug: `support-sibling-${batch}-${i}`,
          bio: "",
          capabilities: [],
          topics: [],
          role: "editor",
          blocked: false,
          contributionCount: 0,
          reviewCount: 0,
          updatedAt: Date.now(),
          ownerId: "support-owner-0",
        })
        await ctx.db.insert("commentVotes", {
          commentId: comments[0],
          agentId: sibling,
          value: 1,
        })
      }
    })
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await phase(t, resourceId, "finalize")
  const caseId = await moderationCase(t, writers[0].agentId, comments[0])
  await t.run((ctx) => setHold(ctx, caseId, comments[0]))
  await settle(t)
  expect(await credit(t, resourceId, "discussion")).toBeNull()
  const c = await t.run((ctx) => ctx.db.get(caseId))
  await t.run((ctx) => liftCase(ctx, c!))
  await settle(t)
  const event = await credit(t, resourceId, "discussion")
  expect(event?.points).toBe(1)
  expect((await jobFor(t, resourceId))?.supporters).toBe(5)
  await t.mutation(internal.admin.reapplyTakedowns, {
    entries: [
      {
        action: "comment_redaction",
        targetId: comments[2],
        actorId: author.agentId,
      },
    ],
  })
  await settle(t)
  expect((await credit(t, resourceId, "discussion"))?.reversedAt).toBeDefined()
  expect(
    await t.run((ctx) => ctx.db.query("communityRecomputeOwners").collect())
  ).toEqual([])
  // Late public votes still atomically update their own score after reconciliation.
  await t.mutation(internal.commands.execute, {
    token: voters[1].token,
    operation: "vote_comment",
    input: { commentId: comments[1], value: -1 },
  })
  expect((await t.run((ctx) => ctx.db.get(comments[1])))?.score).toBe(-2)
  await settle(t)
  expect((await credit(t, resourceId, "discussion"))?.reversedAt).toBeDefined()
}, 60_000)

it("indexes active sanctions without scanning large lifted and expired histories", async () => {
  const t = setup(),
    subject = await agent(t, "sanctioned-owner", "history-owner"),
    caseId = await moderationCase(t, subject.agentId, subject.agentId)
  for (let batch = 0; batch < 50; batch++)
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("sanctions", {
          caseId,
          principal: "owner:history-owner",
          provisional: true,
          ...(i % 2
            ? { liftedAt: Date.now() - 1 }
            : { expiresAt: Date.now() - 1 }),
        })
    })
  expect(
    await t.run((ctx) => principalRestricted(ctx, "owner:history-owner"))
  ).toBe(false)
  const temporary = await t.run((ctx) =>
    ctx.db.insert("sanctions", {
      caseId,
      principal: "owner:history-owner",
      provisional: true,
      expiresAt: Date.now() + 1000,
    })
  )
  expect(
    await t.run((ctx) => principalRestricted(ctx, "owner:history-owner"))
  ).toBe(true)
  vi.advanceTimersByTime(1001)
  expect(
    await t.run((ctx) => principalRestricted(ctx, "owner:history-owner"))
  ).toBe(false)
  await t.run((ctx) => ctx.db.patch(temporary, { expiresAt: undefined }))
  expect(
    await t.run((ctx) => principalRestricted(ctx, "owner:history-owner"))
  ).toBe(true)
  await t.run((ctx) => ctx.db.patch(temporary, { liftedAt: Date.now() }))
  expect(
    await t.run((ctx) => principalRestricted(ctx, "owner:history-owner"))
  ).toBe(false)
})

it("rechecks hidden parents and current revisions before awarding legacy votes", async () => {
  const t = setup(),
    { resourceId } = await votedPost(t, "visibility")
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await phase(t, resourceId, "finalize")
  const revisionId = (await t.run((ctx) => ctx.db.get(resourceId)))!
    .currentRevisionId!
  await t.run(async (ctx) => {
    await ctx.db.patch(revisionId, { quarantined: true })
    await invalidateCommunityTarget(ctx, revisionId)
  })
  await settle(t)
  expect(await credit(t, resourceId)).toBeNull()
  await t.run(async (ctx) => {
    await ctx.db.patch(revisionId, { quarantined: false })
    await invalidateCommunityTarget(ctx, revisionId)
  })
  await settle(t)
  expect((await credit(t, resourceId))?.points).toBe(1)
  const item = (await t.run((ctx) => ctx.db.get(resourceId)))!
  const spaceId = await t.run((ctx) =>
    ctx.db.insert("spaces", {
      kind: "community",
      name: "Fixture community",
      slug: "fixture-community",
      description: "Fixture",
      ownerId: item.authorId,
      suppressed: false,
      updatedAt: Date.now(),
    })
  )
  await t.run((ctx) => ctx.db.patch(resourceId, { spaceId }))
  const caseId = await moderationCase(t, item.authorId, spaceId)
  await t.run((ctx) => setHold(ctx, caseId, spaceId))
  await settle(t)
  expect((await credit(t, resourceId))?.reversedAt).toBeDefined()
  await t.run(async (ctx) => liftCase(ctx, (await ctx.db.get(caseId))!))
  await settle(t)
  expect((await credit(t, resourceId))?.reversedAt).toBeUndefined()
  await t.mutation(internal.admin.reapplySuppressions, { ids: [resourceId] })
  await settle(t)
  expect((await credit(t, resourceId))?.reversedAt).toBeDefined()
})

it("invalidates actual WorkOS ownership claims while repeated authentication leaves work stable", async () => {
  const t = setup(),
    identity = {
      registrationId: "ownership-fixture",
      expiresAt: Date.now() + DAY,
      scopes: ["profile:write"],
    }
  const created = await t.mutation(internal.workosIdentity.provision, {
    identity,
    input: { name: "Claim fixture", slug: "claim-fixture" },
  })
  expect(created?.claimed).toBe(false)
  expect(
    await t.run((ctx) => ctx.db.query("communityReputationState").unique())
  ).toBeNull()
  const claimed = { ...identity, ownerId: "claim-owner" }
  await t.mutation(internal.workosIdentity.provision, { identity: claimed })
  const before = await t.run((ctx) =>
    ctx.db.query("communityReputationState").unique()
  )
  expect(before?.authorityVersion).toBe(1)
  await t.mutation(internal.workosIdentity.provision, { identity: claimed })
  expect(
    await t.run((ctx) => ctx.db.query("communityReputationState").unique())
  ).toEqual(before)
  await settle(t)
})

it("retires a corpus of maximum-sized forensic evidence in bounded transactions", async () => {
  const t = setup(),
    subject = await agent(t, "forensic-subject")
  for (let i = 0; i < 30; i++) {
    const caseId = await moderationCase(t, subject.agentId, subject.agentId)
    await t.run(async (ctx) => {
      await ctx.db.patch(caseId, { resolvedAt: Date.now() - 91 * DAY })
      await ctx.db.insert("moderationEvidence", {
        caseId,
        content: "x".repeat(600_000),
        fingerprint: "fixture",
        provenance: "forensic-fixture",
      })
    })
  }
  await t.mutation(internal.governance.retention, {})
  await expect(
    t.mutation(internal.governance.retireEvidence, { generation: 1, step: 0 })
  ).resolves.toBeNull()
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(
    await t.run((ctx) => ctx.db.query("moderationEvidence").collect())
  ).toEqual([])
  const cases = await t.run((ctx) => ctx.db.query("moderationCases").collect())
  expect(cases.every((c) => !!c.evidencePurgedAt)).toBe(true)
})

it("retains historical beneficiaries and detects a ring introduced by reassignment", async () => {
  const t = setup(),
    { author, resourceId } = await votedPost(t, "transfer")
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await settle(t)
  const before = await credit(t, resourceId)
  expect(before?.points).toBe(1)
  // This migration fixture models an ownership reassignment, which public
  // registration itself forbids. It must not erase historical vote edges.
  await t.run(async (ctx) => {
    await ctx.db.insert("approvedOwners", {
      ownerId: "new-beneficiary",
      approved: true,
      decidedBy: "fixture",
      reason: "Fixture",
      updatedAt: Date.now(),
    })
    await ctx.db.patch(author.agentId, { ownerId: "new-beneficiary" })
    await ctx.db.insert("reputationVotes", {
      sourceId: "migration-ring",
      fromOwner: "new-beneficiary",
      toOwner: "transfer-voter-0",
      active: true,
      updatedAt: Date.now(),
    })
    await invalidateCommunityAuthority(ctx)
  })
  await settle(t)
  expect((await credit(t, resourceId))?.reversedAt).toBeDefined()
  const edges = await t.run((ctx) =>
    ctx.db
      .query("reputationVotes")
      .withIndex("by_source", (q) => q.eq("sourceId", resourceId))
      .collect()
  )
  expect(
    edges
      .filter((edge) => edge.fromOwner === "transfer-voter-0")
      .map((edge) => edge.toOwner)
      .sort()
  ).toEqual(["new-beneficiary", "transfer-owner"])
})

it("refreshes expired relationships only for actual qualifying vote changes", async () => {
  const t = setup(),
    { resourceId, voters } = await votedPost(t, "expiry")
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await settle(t)
  const read = () =>
    t.run((ctx) =>
      ctx.db
        .query("reputationVotes")
        .withIndex("by_source_from_to", (q) =>
          q
            .eq("sourceId", resourceId)
            .eq("fromOwner", "expiry-voter-0")
            .eq("toOwner", "expiry-owner")
        )
        .unique()
    )
  const before = await read()
  vi.advanceTimersByTime(31 * DAY)
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  await settle(t)
  expect((await read())?.updatedAt).toBe(before?.updatedAt)
  await t.mutation(internal.commands.execute, {
    token: voters[0].token,
    operation: "vote",
    input: { resourceId, value: 1 },
  })
  await settle(t)
  expect((await read())?.updatedAt).toBe(before?.updatedAt)
  await t.mutation(internal.commands.execute, {
    token: voters[0].token,
    operation: "vote",
    input: { resourceId, value: 0 },
  })
  await settle(t)
  expect((await read())?.updatedAt).toBe(before?.updatedAt)
  await t.mutation(internal.commands.execute, {
    token: voters[0].token,
    operation: "vote",
    input: { resourceId, value: -1 },
  })
  await settle(t)
  expect((await read())?.updatedAt).toBeGreaterThan(before!.updatedAt)
})

it("locks a retiring parent against partial evidence inheritance and preserves active child families", async () => {
  const t = setup(),
    subject = await agent(t, "retiring-parent")
  const parent = await moderationCase(t, subject.agentId, subject.agentId)
  await t.run(async (ctx) => {
    await ctx.db.patch(parent, { resolvedAt: Date.now() - 91 * DAY })
    for (let i = 0; i < 5; i++)
      await ctx.db.insert("moderationEvidence", {
        caseId: parent,
        content: "x".repeat(600_000),
        fingerprint: `fixture-${i}`,
        provenance: "forensic-fixture",
      })
  })
  for (let batch = 0; batch < 3; batch++)
    await t.run(async (ctx) => {
      for (let i = 0; i < 100; i++)
        await ctx.db.insert("sanctions", {
          caseId: parent,
          principal: `ip:expired-${batch}-${i}`,
          provisional: false,
          expiresAt: Date.now() - 1,
        })
    })
  await t.run(async (ctx) => {
    await ctx.db.insert("sanctions", {
      caseId: parent,
      principal: "ip:active",
      provisional: false,
      expiresAt: Date.now() + DAY,
    })
    await ctx.db.insert("sanctions", {
      caseId: parent,
      principal: "ip:permanent",
      provisional: false,
    })
    await ctx.db.insert("sanctions", {
      caseId: parent,
      principal: "owner:historical",
      provisional: false,
      expiresAt: Date.now() - 1,
    })
  })
  await t.mutation(internal.governance.retention, {})
  await t.mutation(internal.governance.retireEvidence, {
    generation: 1,
    step: 0,
  })
  await t.mutation(internal.governance.retireEvidence, {
    generation: 1,
    step: 1,
  })
  const retiring = await t.run((ctx) => ctx.db.get(parent))
  expect(retiring?.evidenceRetiringAt).toBeDefined()
  expect(retiring?.evidencePurgedAt).toBeUndefined()
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("moderationEvidence")
        .withIndex("by_case", (q) => q.eq("caseId", parent))
        .take(10)
    )
  ).toHaveLength(3)
  await expect(
    t.run((ctx) =>
      createCase(ctx, {
        kind: "appeal",
        reason: "malicious_conduct",
        targetKind: "agent",
        targetId: subject.agentId,
        subjectId: subject.agentId,
        parentCaseId: parent,
        dedupeKey: "partial-inheritance",
        evidence: "Must never inherit a partially deleted snapshot",
        provenance: "fixture",
      })
    )
  ).rejects.toThrow("retiring expired evidence")
  expect(
    await t.run((ctx) =>
      ctx.db
        .query("moderationCases")
        .withIndex("by_parent", (q) => q.eq("parentCaseId", parent))
        .collect()
    )
  ).toEqual([])
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(await t.run((ctx) => ctx.db.get(parent))).toMatchObject({
    evidencePurgedAt: expect.any(Number),
  })
  expect(
    (await t.run((ctx) => ctx.db.get(parent)))?.evidenceRetiringAt
  ).toBeUndefined()
  const retainedSanctions = await t.run((ctx) =>
    ctx.db
      .query("sanctions")
      .withIndex("by_case", (q) => q.eq("caseId", parent))
      .collect()
  )
  expect(retainedSanctions.map((row) => row.principal).sort()).toEqual([
    "ip:active",
    "ip:permanent",
    "owner:historical",
  ])
  for (const state of ["queued", "resolved"] as const) {
    const protectedParent = await moderationCase(
      t,
      subject.agentId,
      subject.agentId
    )
    const child = await moderationCase(t, subject.agentId, subject.agentId)
    await t.run(async (ctx) => {
      await ctx.db.patch(protectedParent, { resolvedAt: Date.now() - 91 * DAY })
      await ctx.db.patch(child, {
        parentCaseId: protectedParent,
        state,
        ...(state === "resolved" ? { resolvedAt: Date.now() - DAY } : {}),
      })
      await ctx.db.insert("moderationEvidence", {
        caseId: protectedParent,
        content: "Preserve this evidence",
        fingerprint: "protected",
        provenance: "fixture",
      })
    })
    await t.mutation(internal.governance.retention, {})
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(
      (await t.run((ctx) => ctx.db.get(protectedParent)))?.evidencePurgedAt
    ).toBeUndefined()
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("moderationEvidence")
          .withIndex("by_case", (q) => q.eq("caseId", protectedParent))
          .take(1)
      )
    ).toHaveLength(1)
  }
})

it("applies the ring budget to total graph work across many individually small adjacency lists", async () => {
  const t = setup(),
    { resourceId } = await votedPost(t, "dense-ring")
  const ownerId = (n: number) =>
    n === 0 ? "dense-ring-owner" : `dense-ring-node-${n}`
  for (let from = 0; from < 30; from++)
    await t.run(async (ctx) => {
      for (let offset = 1; offset <= 25; offset++)
        await ctx.db.insert("reputationVotes", {
          sourceId: `dense-${from}-${offset}`,
          fromOwner: ownerId(from),
          toOwner: ownerId((from + offset) % 30),
          active: true,
          updatedAt: Date.now(),
        })
    })
  await t.run((ctx) => recomputeCommunity(ctx, resourceId))
  const job = await phase(t, resourceId, "postVotes")
  expect(job?.ringSaturated).toBe(true)
  expect(job?.ringOwners.length).toBeGreaterThan(1)
  expect(job?.ringOwners.length).toBeLessThanOrEqual(21)
  await settle(t)
  expect(await credit(t, resourceId)).toBeNull()
})
