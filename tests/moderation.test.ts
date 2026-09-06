/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, internal, components } from "../convex/_generated/api"
import type { Id, Doc } from "../convex/_generated/dataModel"
import { digest } from "../lib/hash"
import { DAY, ballotResult, voteWeight } from "../lib/moderation-policy"
import {
  normalizeIp,
  privateIpHash,
  signGateway,
  verifyGateway,
} from "../lib/gateway-security"
import { createCase, openAppeal } from "../convex/moderation/cases"
import { decide } from "../convex/moderation/decisions"
import { impose, liftCase, addSanction } from "../convex/moderation/sanctions"
import {
  agentRestricted,
  reputation,
  setPersonalBlock,
} from "../convex/moderation/access"
import { award, recomputeCommunity } from "../convex/moderation/reputation"
import { respond, ballot, closeRound } from "../convex/moderation/rounds"
import { caseView } from "../convex/moderation/reads"
const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
async function agent(t: Test, ownerId?: string) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("agents", {
      name: "Test agent",
      slug: `test-${crypto.randomUUID()}`,
      bio: "",
      capabilities: [],
      topics: [],
      role: "editor",
      blocked: false,
      contributionCount: 0,
      reviewCount: 0,
      updatedAt: Date.now(),
      ...(ownerId ? { ownerId } : {}),
    })
    if (
      ownerId &&
      !(await ctx.db
        .query("approvedOwners")
        .withIndex("by_owner", (q) => q.eq("ownerId", ownerId))
        .unique())
    )
      await ctx.db.insert("approvedOwners", {
        ownerId,
        approved: true,
        decidedBy: "test-admin",
        reason: "Verified fixture owner",
        updatedAt: Date.now(),
      })
    return (await ctx.db.get(id))!
  })
}
async function article(t: Test, author: Doc<"agents">) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("resources", {
      kind: "wiki",
      slug: `article-${crypto.randomUUID()}`,
      title: "Legitimate article",
      excerpt: "Useful evidence",
      authorId: author._id,
      topic: "science",
      score: 0,
      commentCount: 0,
      disputed: false,
      suppressed: false,
      protection: "open",
      updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id,
      authorId: author._id,
      title: "Legitimate article",
      body: "An article that remains visible when its author is banned.",
      summary: "Initial",
      citations: [],
      attachmentIds: [],
      status: "published",
      suppressed: false,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    return { id, revisionId }
  })
}
async function conduct(
  t: Test,
  subject: Doc<"agents">,
  extra: {
    reason?: string
    resourceId?: Id<"resources">
    revisionId?: Id<"revisions">
    public?: boolean
  } = {}
) {
  return t.run((ctx) =>
    createCase(ctx, {
      kind: "conduct",
      reason: "malicious_conduct",
      targetKind: extra.revisionId ? "revision" : "agent",
      targetId: extra.revisionId ?? subject._id,
      subjectId: subject._id,
      dedupeKey: crypto.randomUUID(),
      evidence: "Immutable evidence for a test case",
      provenance: "test",
      public: true,
      ...extra,
    })
  )
}
async function jury(t: Test, count: number) {
  const jurors = []
  const now = Date.now()
  for (let i = 0; i < count; i++) {
    vi.setSystemTime(now + i * DAY)
    const a = await agent(t, `juror-${i}-${crypto.randomUUID()}`)
    for (let n = 0; n < 4; n++) {
      vi.setSystemTime(now + (i + (n === 3 ? 1 : 0)) * DAY)
      await t.run((ctx) =>
        award(ctx, {
          agentId: a._id,
          source: "task",
          sourceId: crypto.randomUUID(),
        })
      )
    }
    jurors.push(a)
  }
  vi.setSystemTime(now + (count + 16) * DAY)
  return jurors
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-07-01T12:00:00Z"))
  vi.stubEnv("MODERATION_ENABLED", "false")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("frozen reputation-weighted thresholds", () => {
  it("requires both independent headcount and assigned weight", () => {
    expect(voteWeight(24)).toBe(1)
    expect(voteWeight(25)).toBe(2)
    expect(voteWeight(50)).toBe(3)
    expect(
      ballotResult(7, [
        { weight: 3, vote: "accept" },
        ...Array.from({ length: 6 }, () => ({ weight: 1 })),
      ])
    ).toBeNull()
    expect(
      ballotResult(7, [
        ...Array.from({ length: 5 }, () => ({
          weight: 1,
          vote: "accept" as const,
        })),
        { weight: 3 },
        { weight: 3 },
      ])
    ).toBeNull()
    expect(
      ballotResult(7, [
        ...Array.from({ length: 5 }, () => ({
          weight: 1,
          vote: "accept" as const,
        })),
        { weight: 1 },
        { weight: 1 },
      ])
    ).toBe("accept")
    expect(
      ballotResult(
        11,
        Array.from({ length: 11 }, (_, i) => ({
          weight: 1,
          vote: i < 7 ? ("accept" as const) : undefined,
        }))
      )
    ).toBeNull()
    expect(
      ballotResult(
        11,
        Array.from({ length: 11 }, (_, i) => ({
          weight: 1,
          vote: i < 8 ? ("accept" as const) : undefined,
        }))
      )
    ).toBe("accept")
    expect(
      ballotResult(
        7,
        Array.from({ length: 5 }, () => ({
          weight: 1,
          vote: "accept" as const,
        }))
      )
    ).toBeNull()
  })
  it("conceals ballots until closure, forbids changes, and retains nonvoter weight", async () => {
    const t = setup(),
      subject = await agent(t, "subject"),
      jurors = await jury(t, 7),
      id = await conduct(t, subject)
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "test-seed",
      candidates: jurors.map((a) => ({
        agentId: a._id,
        ownerId: a.ownerId!,
        weight: 1,
      })),
    })
    for (const a of jurors) await t.run((ctx) => respond(ctx, a, id, true))
    for (const a of jurors.slice(0, 5))
      await t.run((ctx) =>
        ballot(
          ctx,
          a,
          id,
          1,
          "accept",
          "Evidence supports this specific violation."
        )
      )
    expect((await t.run((ctx) => caseView(ctx, id)))?.tally).toBeNull()
    expect(
      await t.run(async (ctx) =>
        agentRestricted(ctx, (await ctx.db.get(subject._id))!)
      )
    ).toBe(false)
    await expect(
      t.run((ctx) =>
        ballot(
          ctx,
          jurors[0],
          id,
          1,
          "reject",
          "Changed my mind after seeing another ballot"
        )
      )
    ).rejects.toThrow("immutable")
    await expect(
      t.run((ctx) => respond(ctx, jurors[6], id, false))
    ).rejects.toThrow("frozen")
    vi.stubEnv("MODERATION_ENABLED", "true")
    vi.advanceTimersByTime(DAY + 1)
    await t.run(async (ctx) => closeRound(ctx, (await ctx.db.get(id))!))
    expect((await t.run((ctx) => caseView(ctx, id)))?.decision).toBe("accept")
    expect(
      await t.run(async (ctx) =>
        agentRestricted(ctx, (await ctx.db.get(subject._id))!)
      )
    ).toBe(true)
  })
  it("escalates an insufficient pool instead of shrinking the jury", async () => {
    const t = setup(),
      a = await agent(t, "subject"),
      id = await conduct(t, a)
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "once",
      candidates: [],
    })
    expect((await t.run((ctx) => ctx.db.get(id)))?.state).toBe("escalated")
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "reroll",
      candidates: [],
    })
    expect((await t.run((ctx) => ctx.db.get(id)))?.drawSeed).toBe("once")
  })
  it("keeps committees private in public task retrieval", async () => {
    const t = setup(),
      subject = await agent(t, "subject"),
      jurors = await jury(t, 7),
      id = await conduct(t, subject)
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "test",
      candidates: jurors.map((a) => ({
        agentId: a._id,
        ownerId: a.ownerId!,
        weight: 1,
      })),
    })
    const seat = await t.run((ctx) => ctx.db.query("committeeSeats").first())
    expect(await t.query(api.public.getTask, { id: seat!.taskId })).toBeNull()
    expect(
      (
        await t.query(api.public.tasks, {
          paginationOpts: { cursor: null, numItems: 20 },
        })
      ).items
    ).toEqual([])
  })
})

describe("trusted gateway", () => {
  const secret = "gateway-secret-for-tests",
    ipSecret = "private-ip-secret-for-tests"
  it("normalizes IPv4-mapped IPv6 and hashes exact addresses", () => {
    expect(normalizeIp("::ffff:192.0.2.8")).toBe("192.0.2.8")
    expect(privateIpHash("::ffff:192.0.2.8", ipSecret)).toBe(
      privateIpHash("192.0.2.8", ipSecret)
    )
    expect(privateIpHash("2001:db8::1", ipSecret)).not.toBe(
      privateIpHash("2001:db8::2", ipSecret)
    )
    expect(() => normalizeIp("192.0.2.8, 192.0.2.9")).toThrow()
    expect(() => normalizeIp("fe80::1%en0")).toThrow()
  })
  it("binds the method, path, body, credential and address, with an expiry", () => {
    const p = {
      method: "POST",
      path: "/api/v1/commands/publish",
      body: '{"body":"hello"}',
      authorization: "Bearer test",
      timestamp: Date.now(),
      nonce: "a".repeat(64),
      ipHash: privateIpHash("192.0.2.8", ipSecret),
    }
    const envelope = signGateway(secret, p)
    expect(verifyGateway(secret, envelope, p)).toEqual(envelope)
    for (const [field, value] of Object.entries({
      method: "GET",
      path: "/api/v1/agents",
      body: "{}",
      authorization: "Bearer other",
    }))
      expect(
        verifyGateway(secret, envelope, { ...p, [field]: value })
      ).toBeNull()
    expect(
      verifyGateway(secret, { ...envelope, ipHash: "0".repeat(64) }, p)
    ).toBeNull()
    expect(verifyGateway(secret, envelope, p, p.timestamp + 60001)).toBeNull()
  })
  it("rejects nonce replay and preserves appeal access on a banned network", async () => {
    const t = setup(),
      a = await agent(t),
      c = await conduct(t, a)
    await t.run((ctx) =>
      addSanction(ctx, c, "ip:test-ip", false, Date.now() + 30 * DAY)
    )
    expect(
      await t.mutation(internal.governance.networkGate, {
        nonce: "one",
        ipHash: "test-ip",
        appeal: false,
      })
    ).toEqual({ error: "BANNED" })
    expect(
      await t.mutation(internal.governance.networkGate, {
        nonce: "one",
        ipHash: "test-ip",
        appeal: true,
      })
    ).toEqual({ error: "REPLAY" })
    expect(
      await t.mutation(internal.governance.networkGate, {
        nonce: "two",
        ipHash: "test-ip",
        appeal: true,
      })
    ).toEqual({ error: null })
  })
})

describe("case-scoped sanctions and content", () => {
  it("bans siblings without deleting legitimate articles", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      sibling = await agent(t, "owner"),
      paper = await article(t, a),
      c = await conduct(t, a)
    await t.run(async (ctx) =>
      decide(
        ctx,
        (await ctx.db.get(c))!,
        "accept",
        "admin",
        "Verified malicious behavior in immutable evidence."
      )
    )
    expect(await t.run((ctx) => agentRestricted(ctx, sibling))).toBe(true)
    const result = await t.query(api.public.getResource, { slugOrId: paper.id })
    expect(result?.revision.body).toContain("remains visible")
    expect(result?.revision.author.moderationStatus).toBe("removed")
  })
  it("expires provisional bans without destroying evidence or repeatedly renewing them", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      paper = await article(t, a),
      c = await conduct(t, a, {
        reason: "prompt_injection",
        resourceId: paper.id,
        revisionId: paper.revisionId,
      })
    await t.run(async (ctx) => impose(ctx, (await ctx.db.get(c))!, true))
    vi.advanceTimersByTime(23 * 3600000)
    await t.run(async (ctx) => impose(ctx, (await ctx.db.get(c))!, true))
    vi.advanceTimersByTime(2 * 3600000)
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
    expect(
      await t.query(api.public.getResource, { slugOrId: paper.id })
    ).toBeNull()
    expect(
      (await t.run((ctx) => ctx.db.query("moderationEvidence").collect()))
        .length
    ).toBe(1)
  })
  it("restores only one case's holds and never overwrites subsequent revisions", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      paper = await article(t, a)
    const c1 = await conduct(t, a, {
        reason: "prompt_injection",
        resourceId: paper.id,
        revisionId: paper.revisionId,
      }),
      c2 = await conduct(t, a, {
        reason: "prompt_injection",
        resourceId: paper.id,
        revisionId: paper.revisionId,
      })
    for (const id of [c1, c2])
      await t.run(async (ctx) => impose(ctx, (await ctx.db.get(id))!, false))
    await t.run(async (ctx) => liftCase(ctx, (await ctx.db.get(c1))!))
    expect(
      await t.query(api.public.getResource, { slugOrId: paper.id })
    ).toBeNull()
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(true)
    await t.run(async (ctx) => liftCase(ctx, (await ctx.db.get(c2))!))
    expect(
      (await t.query(api.public.getResource, { slugOrId: paper.id }))?.revision
        .id
    ).toBe(paper.revisionId)
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
  })
  it("excludes original jurors and admits only one ordinary appeal", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      jurors = await jury(t, 7),
      id = await conduct(t, a)
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "test",
      candidates: jurors.map((a) => ({
        agentId: a._id,
        ownerId: a.ownerId!,
        weight: 1,
      })),
    })
    await t.run(async (ctx) =>
      decide(
        ctx,
        (await ctx.db.get(id))!,
        "accept",
        "admin-one",
        "Verified malicious conduct from preserved evidence."
      )
    )
    const appeal = await t.run(async (ctx) =>
      openAppeal(
        ctx,
        "owner",
        (await ctx.db.get(id))!,
        "The quoted text was evidence, not a malicious instruction."
      )
    )
    const repeated = await t.run(async (ctx) =>
      openAppeal(
        ctx,
        "owner",
        (await ctx.db.get(id))!,
        "A duplicate retry should return the same appeal."
      )
    )
    expect(repeated.caseId).toBe(appeal.caseId)
    const c = (await t.run((ctx) => ctx.db.get(appeal.caseId)))!
    expect(c.excludedOwners).toEqual(
      expect.arrayContaining(jurors.map((j) => j.ownerId!))
    )
    expect(c.excludedOwners).toContain("admin-one")
    await t.run((ctx) =>
      decide(
        ctx,
        c,
        "accept",
        "admin-two",
        "The original detector finding was a false positive."
      )
    )
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
  })
  it("does not expose private report evidence or create a public accusation at intake", async () => {
    const t = setup(),
      a = await agent(t, "owner")
    const id = await t.run((ctx) =>
      createCase(ctx, {
        kind: "admission",
        reason: "spam",
        targetKind: "agent",
        targetId: a._id,
        subjectId: a._id,
        dedupeKey: "one-report",
        evidence: "Private allegation includes malicious quoted text",
        provenance: "report",
      })
    )
    expect(await t.run((ctx) => caseView(ctx, id))).toBeNull()
    const profile = await t.query(api.public.getAgent, { slug: a.slug })
    expect(profile?.moderationStatus).toBe("clear")
  })
})

describe("reputation fraud controls", () => {
  it("matures after seven days, caps per owner, and never pays twice", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      sibling = await agent(t, "owner")
    for (let i = 0; i < 5; i++)
      await t.run((ctx) =>
        award(ctx, {
          agentId: i % 2 ? sibling._id : a._id,
          source: "task",
          sourceId: `task-${i}`,
        })
      )
    expect(
      (await t.run((ctx) => ctx.db.query("reputationEvents").collect())).length
    ).toBe(3)
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(0)
    vi.advanceTimersByTime(7 * DAY)
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(6)
    await t.run((ctx) =>
      award(ctx, { agentId: a._id, source: "task", sourceId: "task-0" })
    )
    expect(
      (await t.run((ctx) => ctx.db.query("reputationEvents").collect())).length
    ).toBe(3)
    vi.advanceTimersByTime(180 * DAY)
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(0)
  })
  it("does not turn many sibling votes into independent owner credit", async () => {
    const t = setup(),
      author = await agent(t, "author"),
      paper = await article(t, author)
    await t.run((ctx) => ctx.db.patch(paper.id, { kind: "post" }))
    for (let i = 0; i < 6; i++) {
      const voter = await agent(t, "one-voting-owner")
      await t.run((ctx) =>
        ctx.db.insert("votes", {
          resourceId: paper.id,
          agentId: voter._id,
          value: 1,
        })
      )
    }
    await t.run((ctx) => recomputeCommunity(ctx, paper.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(
      (await t.run((ctx) => ctx.db.query("reputationEvents").collect())).length
    ).toBe(0)
    for (let i = 0; i < 4; i++) {
      const voter = await agent(t, `other-${i}`)
      await t.run((ctx) =>
        ctx.db.insert("votes", {
          resourceId: paper.id,
          agentId: voter._id,
          value: 1,
        })
      )
    }
    await t.run((ctx) => recomputeCommunity(ctx, paper.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(
      (await t.run((ctx) => ctx.db.query("reputationEvents").collect())).length
    ).toBe(1)
  })
  it("holds an award during quarantine and restores its original maturation after reversal", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      paper = await article(t, a)
    await t.run((ctx) =>
      award(ctx, {
        agentId: a._id,
        source: "article",
        sourceId: paper.revisionId,
        resourceId: paper.id,
        revisionId: paper.revisionId,
      })
    )
    vi.advanceTimersByTime(7 * DAY)
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(3)
    const id = await conduct(t, a, {
      reason: "prompt_injection",
      resourceId: paper.id,
      revisionId: paper.revisionId,
    })
    await t.run(async (ctx) => impose(ctx, (await ctx.db.get(id))!, true))
    await t.mutation(internal.governance.maintainReputation, {})
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(0)
    await t.run(async (ctx) => liftCase(ctx, (await ctx.db.get(id))!))
    expect((await t.run((ctx) => reputation(ctx, a._id))).score).toBe(3)
  })
  it("keeps personal blocks private and unrelated to reputation", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      b = await agent(t, "other")
    await t.run((ctx) => setPersonalBlock(ctx, `agent:${a._id}`, b._id, true))
    expect(await t.run((ctx) => agentRestricted(ctx, b))).toBe(false)
    expect(
      (await t.run((ctx) => ctx.db.query("reputationEvents").collect())).length
    ).toBe(0)
  })
})

async function human(t: Test) {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Human",
        email: `${crypto.randomUUID()}@example.test`,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        token: crypto.randomUUID(),
        expiresAt: Date.now() + 90 * DAY,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  return {
    id: user._id,
    client: t.withIdentity({ subject: user._id, sessionId: session._id }),
  }
}
describe("human recovery and editorial boundaries", () => {
  it("rejects administrator impersonation and conflicted decisions", async () => {
    const t = setup(),
      owner = await human(t),
      admin = await human(t),
      a = await agent(t, owner.id),
      id = await conduct(t, a)
    await t.run((ctx) => ctx.db.patch(id, { state: "escalated" }))
    const input = {
      action: "decide" as const,
      targetId: id,
      enabled: true,
      reason: "A verified and documented decision based on preserved evidence.",
    }
    await expect(
      owner.client.mutation(api.moderationHumans.adminAction, input)
    ).rejects.toThrow("administrator")
    vi.stubEnv("MODERATION_ADMIN_USER_IDS", `${owner.id},${admin.id}`)
    await expect(
      owner.client.mutation(api.moderationHumans.adminAction, input)
    ).rejects.toThrow("nonconflicted")
    await admin.client.mutation(api.moderationHumans.adminAction, input)
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(true)
    const appeal = await owner.client.mutation(api.moderationHumans.appeal, {
      caseId: id,
      reason: "The evidence shows a benign quotation of hostile instructions.",
    })
    expect(
      (
        await owner.client.query(api.moderationHumans.detail, {
          caseId: appeal.caseId,
        })
      )?.kind
    ).toBe("appeal")
    // Both the owner and original administrator are excluded from the appeal.
    await t.run((ctx) => ctx.db.patch(appeal.caseId, { state: "escalated" }))
    await expect(
      admin.client.mutation(api.moderationHumans.adminAction, {
        ...input,
        targetId: appeal.caseId,
      })
    ).rejects.toThrow("nonconflicted")
  })
  it("allows a one-use ownership proof for appeals without linking or unbanning the agent", async () => {
    const t = setup(),
      h = await human(t),
      a = await agent(t),
      id = await conduct(t, a),
      token = "an_fixture-owner-key",
      code = "appeal-fixture-code"
    await t.run(async (ctx) => {
      await ctx.db.insert("keys", {
        agentId: a._id,
        hash: digest(token),
        prefix: "an_fixture",
        label: "Owner",
        scopes: ["keys:write"],
      })
      await decide(
        ctx,
        (await ctx.db.get(id))!,
        "accept",
        "admin",
        "Confirmed misconduct from exact recorded evidence."
      )
    })
    await t.mutation(internal.moderationHumans.storeAppealLink, {
      token,
      hash: digest(code),
    })
    expect(
      await h.client.mutation(api.moderationHumans.claimAppeal, {
        linkingCode: code,
      })
    ).toEqual({ agentId: a._id })
    expect(
      await h.client.mutation(api.moderationHumans.claimAppeal, {
        linkingCode: code,
      })
    ).toHaveProperty("error")
    expect((await t.run((ctx) => ctx.db.get(a._id)))?.ownerId).toBeUndefined()
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(true)
    expect(
      await h.client.mutation(api.moderationHumans.appeal, {
        caseId: id,
        reason:
          "Please reconsider this finding using the preserved original context.",
      })
    ).toHaveProperty("caseId")
  })
  it("allows exactly one emergency hold extension and labels provisional cases as investigations", async () => {
    const t = setup(),
      h = await human(t),
      a = await agent(t),
      id = await conduct(t, a, { reason: "prompt_injection" })
    vi.stubEnv("MODERATION_ADMIN_USER_IDS", h.id)
    await t.run(async (ctx) => impose(ctx, (await ctx.db.get(id))!, true))
    expect(
      (await t.query(api.public.getAgent, { slug: a.slug }))?.moderationStatus
    ).toBe("investigating")
    const input = {
      action: "extend_hold" as const,
      targetId: id,
      enabled: true,
      reason: "Additional time is needed to review exact detector evidence.",
    }
    await h.client.mutation(api.moderationHumans.adminAction, input)
    await expect(
      h.client.mutation(api.moderationHumans.adminAction, input)
    ).rejects.toThrow("again")
    vi.advanceTimersByTime(2 * DAY + 1)
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
  })
  it("escalates a stale editorial correction instead of overwriting newer work", async () => {
    const t = setup(),
      a = await agent(t, "writer"),
      editor = await agent(t, "editor"),
      paper = await article(t, a)
    const { proposal, id } = await t.run(async (ctx) => {
      const old = (await ctx.db.get(paper.revisionId))!
      const proposal = await ctx.db.insert("revisions", {
        resourceId: paper.id,
        authorId: editor._id,
        parentRevisionId: paper.revisionId,
        title: old.title,
        body: "Proposed correction",
        summary: "Correct the source attribution.",
        citations: [],
        attachmentIds: [],
        status: "pending",
        suppressed: false,
      })
      const id = await createCase(ctx, {
        kind: "editorial",
        reason: "editorial",
        targetKind: "revision",
        targetId: paper.revisionId,
        subjectId: a._id,
        resourceId: paper.id,
        revisionId: paper.revisionId,
        proposedRevisionId: proposal,
        dedupeKey: "editorial",
        evidence: "Exact correction proposal",
        provenance: "test",
        public: true,
      })
      const latest = await ctx.db.insert("revisions", {
        resourceId: paper.id,
        authorId: a._id,
        parentRevisionId: paper.revisionId,
        title: old.title,
        body: "Newer independent work",
        summary: "Updated",
        citations: [],
        attachmentIds: [],
        status: "published",
        suppressed: false,
      })
      await ctx.db.patch(paper.id, { currentRevisionId: latest })
      return { proposal, id }
    })
    await t.run(async (ctx) =>
      decide(
        ctx,
        (await ctx.db.get(id))!,
        "accept",
        "admin",
        "A stale proposal must not overwrite a later edit."
      )
    )
    expect((await t.run((ctx) => ctx.db.get(id)))?.state).toBe("escalated")
    expect((await t.run((ctx) => ctx.db.get(proposal)))?.status).toBe("pending")
    expect(
      (await t.query(api.public.getResource, { slugOrId: paper.id }))?.revision
        .body
    ).toBe("Newer independent work")
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
  })
  it("keeps a seated juror's weight frozen when their reputation later increases", async () => {
    const t = setup(),
      a = await agent(t, "subject"),
      jurors = await jury(t, 7),
      id = await conduct(t, a)
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "test",
      candidates: jurors.map((a) => ({
        agentId: a._id,
        ownerId: a.ownerId!,
        weight: 1,
      })),
    })
    for (const j of jurors) await t.run((ctx) => respond(ctx, j, id, true))
    await t.run(async (ctx) => {
      const award = await ctx.db
        .query("reputationEvents")
        .withIndex("by_agent", (q) => q.eq("agentId", jurors[0]._id))
        .first()
      await ctx.db.patch(award!._id, { points: 70 })
    })
    expect(
      (await t.run((ctx) => reputation(ctx, jurors[0]._id))).score
    ).toBeGreaterThan(50)
    const seat = await t.run((ctx) =>
      ctx.db
        .query("committeeSeats")
        .withIndex("by_agent", (q) => q.eq("agentId", jurors[0]._id))
        .first()
    )
    expect(seat?.weight).toBe(1)
  })
})

describe("admission and reputation reversals", () => {
  it("requires independent admission and excludes those reviewers from the final jury", async () => {
    const t = setup(),
      a = await agent(t, "subject"),
      jurors = await jury(t, 3)
    const id = await t.run((ctx) =>
      createCase(ctx, {
        kind: "admission",
        reason: "spam",
        targetKind: "agent",
        targetId: a._id,
        subjectId: a._id,
        reporterOwnerId: "reporter",
        dedupeKey: "admission-example",
        evidence: "Evidence for independent admission review.",
        provenance: "test",
      })
    )
    await t.mutation(internal.governance.installDraw, {
      caseId: id,
      seed: "test",
      candidates: jurors.map((a) => ({
        agentId: a._id,
        ownerId: a.ownerId!,
        weight: 1,
      })),
    })
    for (const j of jurors) await t.run((ctx) => respond(ctx, j, id, true))
    for (const j of jurors.slice(0, 2))
      await t.run((ctx) =>
        ballot(
          ctx,
          j,
          id,
          1,
          "accept",
          "Sufficient evidence exists for an investigation."
        )
      )
    expect(await t.run((ctx) => caseView(ctx, id))).toBeNull()
    vi.advanceTimersByTime(DAY + 1)
    await t.run(async (ctx) => closeRound(ctx, (await ctx.db.get(id))!))
    const admitted = await t.run((ctx) =>
      ctx.db
        .query("moderationCases")
        .withIndex("by_parent", (q) => q.eq("parentCaseId", id))
        .first()
    )
    expect(admitted).toMatchObject({ kind: "conduct", public: true })
    expect(admitted?.excludedOwners).toEqual(
      expect.arrayContaining(jurors.map((j) => j.ownerId!))
    )
    expect(await t.run((ctx) => agentRestricted(ctx, a))).toBe(false)
  })
  it("reverses reciprocal-vote awards and does not award self-created task bounties", async () => {
    const t = setup(),
      a = await agent(t, "owner-a"),
      b = await agent(t, "owner-b"),
      pa = await article(t, a),
      pb = await article(t, b)
    await t.run(async (ctx) => {
      await ctx.db.patch(pa.id, { kind: "post" })
      await ctx.db.patch(pb.id, { kind: "post" })
    })
    const voters = await jury(t, 4)
    for (const paper of [pa, pb])
      for (const voter of voters)
        await t.run((ctx) =>
          ctx.db.insert("votes", {
            resourceId: paper.id,
            agentId: voter._id,
            value: 1,
          })
        )
    await t.run((ctx) =>
      ctx.db.insert("votes", { resourceId: pa.id, agentId: b._id, value: 1 })
    )
    await t.run((ctx) => recomputeCommunity(ctx, pa.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const first = await t.run((ctx) =>
      ctx.db
        .query("reputationEvents")
        .withIndex("by_source", (q) =>
          q.eq("source", "post").eq("sourceId", pa.id)
        )
        .unique()
    )
    expect(first).not.toBeNull()
    await t.run((ctx) =>
      ctx.db.insert("votes", { resourceId: pb.id, agentId: a._id, value: 1 })
    )
    await t.run((ctx) => recomputeCommunity(ctx, pb.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    await t.run((ctx) => recomputeCommunity(ctx, pa.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(
      (await t.run((ctx) => ctx.db.get(first!._id)))?.reversedAt
    ).toBeDefined()
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("reputationEvents")
          .withIndex("by_source", (q) =>
            q.eq("source", "post").eq("sourceId", pb.id)
          )
          .unique()
      )
    ).toBeNull()
    const reportId = await t.run(async (ctx) => {
      const taskId = await ctx.db.insert("tasks", {
        type: "maintenance",
        topic: "science",
        title: "Self-created work",
        description: "A test task",
        creatorId: a._id,
        targetId: pa.id,
        revisionId: pa.revisionId,
        status: "completed",
        issueOpen: false,
        random: 0.5,
        updatedAt: Date.now(),
        dedupeKey: "self-bounty",
      })
      const assignmentId = await ctx.db.insert("assignments", {
        taskId,
        agentId: a._id,
        status: "submitted",
        types: ["maintenance"],
        topics: [],
        budgetMinutes: 30,
        expiresAt: Date.now(),
        maxExpiresAt: Date.now(),
      })
      return ctx.db.insert("reports", {
        taskId,
        assignmentId,
        agentId: a._id,
        targetId: pa.id,
        revisionId: pa.revisionId,
        resultResourceId: pa.id,
        resultRevisionId: pa.revisionId,
        report: "Self-created task result",
        verdict: "checked",
        evidence: [],
        historical: false,
        suppressed: false,
      })
    })
    await t.mutation(internal.governance.quality, {
      kind: "task_quality",
      targetId: reportId,
    })
    expect(
      await t.run((ctx) => ctx.db.query("moderationCases").collect())
    ).toHaveLength(0)
  })
  it("awards productive discussion once, then reverses it when supporting votes disappear", async () => {
    const t = setup(),
      author = await agent(t, "author"),
      paper = await article(t, author),
      commenters = await jury(t, 3),
      supporters = await jury(t, 5)
    await t.run((ctx) => ctx.db.patch(paper.id, { kind: "post" }))
    const replies: Id<"comments">[] = []
    for (const writer of commenters)
      replies.push(
        await t.run((ctx) =>
          ctx.db.insert("comments", {
            resourceId: paper.id,
            authorId: writer._id,
            body: "A useful independently authored reply.",
            suppressed: false,
          })
        )
      )
    const votes: Id<"commentVotes">[] = []
    for (const [i, voter] of supporters.entries())
      votes.push(
        await t.run((ctx) =>
          ctx.db.insert("commentVotes", {
            commentId: replies[i % 3],
            agentId: voter._id,
            value: 1,
          })
        )
      )
    await t.run((ctx) => recomputeCommunity(ctx, paper.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const event = await t.run((ctx) =>
      ctx.db
        .query("reputationEvents")
        .withIndex("by_source", (q) =>
          q.eq("source", "discussion").eq("sourceId", paper.id)
        )
        .unique()
    )
    expect(event?.points).toBe(1)
    await t.run((ctx) => ctx.db.patch(votes[0], { value: 0 }))
    await t.run((ctx) => recomputeCommunity(ctx, paper.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    expect(
      (await t.run((ctx) => ctx.db.get(event!._id)))?.reversedAt
    ).toBeDefined()
    await t.run((ctx) => ctx.db.patch(votes[0], { value: 1 }))
    await t.run((ctx) => recomputeCommunity(ctx, paper.id))
    await t.finishAllScheduledFunctions(() => vi.runAllTimers())
    const restored = await t.run((ctx) => ctx.db.get(event!._id))
    expect(restored?.reversedAt).toBeUndefined()
    expect(restored?.maturesAt).toBe(event?.maturesAt)
  })
})

it("rejects unsigned human ownership linking and signed linking from a banned network", async () => {
  const t = setup(),
    h = await human(t),
    a = await agent(t),
    id = await conduct(t, a)
  vi.stubEnv("MODERATION_ENABLED", "true")
  vi.stubEnv("MODERATION_GATEWAY_SECRET", "gateway-test")
  expect(
    await h.client.mutation(api.auth.linkAgent, { linkingCode: "invalid" })
  ).toHaveProperty("error", "Use the signed public account gateway.")
  const ipHash = "b".repeat(64)
  await t.run((ctx) =>
    addSanction(ctx, id, `ip:${ipHash}`, false, Date.now() + DAY)
  )
  const networkProof = signGateway("gateway-test", {
    method: "POST",
    path: "/api/moderation/link-agent",
    body: '{"linkingCode":"invalid"}',
    authorization: `owner:${h.id}`,
    timestamp: Date.now(),
    nonce: "c".repeat(64),
    ipHash,
  })
  expect(
    await h.client.mutation(api.auth.linkAgent, {
      linkingCode: "invalid",
      networkProof,
    })
  ).toHaveProperty(
    "error",
    "This network cannot link contributing agents. Human appeals remain available."
  )
  expect(
    await t.run((ctx) => ctx.db.query("gatewayNonces").collect())
  ).toHaveLength(1)
})

it("invalidates community eligibility only when a human approval actually changes", async () => {
  const t = setup(), admin = await human(t), owner = await human(t)
  vi.stubEnv("MODERATION_ADMIN_USER_IDS", admin.id)
  const input = { action: "approve_owner" as const, targetId: owner.id, enabled: true, reason: "Fixture approval with documented independent evidence." }
  await admin.client.mutation(api.moderationHumans.adminAction, input)
  const before = await t.run((ctx) => ctx.db.query("communityReputationState").unique())
  expect(before?.authorityVersion).toBe(1)
  await admin.client.mutation(api.moderationHumans.adminAction, input)
  expect(await t.run((ctx) => ctx.db.query("communityReputationState").unique())).toEqual(before)
  await admin.client.mutation(api.moderationHumans.adminAction, { ...input, enabled: false })
  expect((await t.run((ctx) => ctx.db.query("communityReputationState").unique()))?.authorityVersion).toBe(2)
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
})
