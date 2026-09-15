/// <reference types="vite/client" />
import { describe, expect, it } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => {
  const t = convexTest({ schema, modules, transactionLimits: true })
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>

async function agent(
  t: Test,
  overrides: Partial<{ role: "editor" | "operator"; blocked: boolean }> = {}
) {
  return t.run(async (ctx) =>
    ctx.db.insert("agents", {
      name: "Purge fixture",
      slug: crypto.randomUUID(),
      bio: "",
      capabilities: [],
      topics: [],
      role: overrides.role ?? "editor",
      blocked: overrides.blocked ?? false,
      ownerId: "purge-owner",
      contributionCount: 0,
      reviewCount: 0,
      updatedAt: Date.now(),
    })
  )
}

async function contribution(t: Test, authorId: Id<"agents">, suppressed: boolean) {
  return t.run(async (ctx) => {
    const id = await ctx.db.insert("resources", {
      kind: "note",
      slug: crypto.randomUUID(),
      title: suppressed ? "Removed contribution" : "Live note",
      excerpt: "",
      authorId,
      topic: "fixture",
      score: 0,
      commentCount: 0,
      disputed: false,
      suppressed,
      protection: "open",
      updatedAt: Date.now(),
    })
    const revisionId = await ctx.db.insert("revisions", {
      resourceId: id,
      authorId,
      title: "Fixture",
      body: "[Removed]",
      summary: "Fixture",
      citations: [],
      attachmentIds: [],
      status: "published",
      suppressed,
    })
    await ctx.db.patch(id, { currentRevisionId: revisionId })
    await ctx.db.insert("events", {
      kind: "published",
      actorId: authorId,
      targetId: id,
      title: "Fixture",
      suppressed,
    })
    return id
  })
}

async function fixture(t: Test) {
  const operator = await agent(t, { role: "operator" })
  const retired = await agent(t, { blocked: true })
  const resourceId = await contribution(t, retired, true)
  const keyId = await t.run(async (ctx) => {
    const keyId = await ctx.db.insert("keys", {
      agentId: retired,
      hash: crypto.randomUUID(),
      prefix: "an_test",
      label: "initial",
      scopes: ["wiki:write"],
    })
    await ctx.db.insert("agentLinks", {
      agentId: retired,
      keyId,
      hash: crypto.randomUUID(),
      expiresAt: Date.now() + 60_000,
    })
    await ctx.db.insert("moderation", {
      actorId: operator,
      targetId: retired,
      action: "block",
      reason: "Retire temporary synthetic launch verification identity.",
    })
    return keyId
  })
  return { operator, retired, resourceId, keyId }
}

describe("admin.purgeRetiredAgent", () => {
  it("removes a blocked identity, its credentials, and suppressed contribution shells while keeping the audit trail", async () => {
    const t = setup()
    const { operator, retired, resourceId, keyId } = await fixture(t)
    const result = await t.mutation(internal.admin.purgeRetiredAgent, {
      agentId: retired,
      reason: "Purge retired launch verification identity.",
    })
    expect(result).toMatchObject({ agentId: retired, resources: 1 })
    await t.run(async (ctx) => {
      expect(await ctx.db.get(retired)).toBeNull()
      expect(await ctx.db.get(resourceId)).toBeNull()
      expect(await ctx.db.get(keyId)).toBeNull()
      expect(
        await ctx.db.query("revisions").withIndex("by_resource", (q) => q.eq("resourceId", resourceId)).collect()
      ).toHaveLength(0)
      expect(
        await ctx.db.query("agentLinks").withIndex("by_agent", (q) => q.eq("agentId", retired)).collect()
      ).toHaveLength(0)
      expect(
        await ctx.db.query("events").withIndex("by_target", (q) => q.eq("targetId", resourceId)).collect()
      ).toHaveLength(0)
      const audit = await ctx.db.query("moderation").withIndex("by_target", (q) => q.eq("targetId", retired)).collect()
      expect(audit.map((row) => row.action).sort()).toEqual(["block", "identity_purge"])
      expect(audit.every((row) => row.actorId === operator)).toBe(true)
      expect(await ctx.db.get(operator)).not.toBeNull()
    })
  })

  it("refuses an agent that is not blocked", async () => {
    const t = setup()
    await fixture(t)
    const active = await agent(t)
    await expect(
      t.mutation(internal.admin.purgeRetiredAgent, { agentId: active, reason: "x" })
    ).rejects.toThrow(/Block the agent/)
    await t.run(async (ctx) => {
      expect(await ctx.db.get(active)).not.toBeNull()
    })
  })

  it("refuses the operator identity", async () => {
    const t = setup()
    const { operator } = await fixture(t)
    await t.run((ctx) => ctx.db.patch(operator, { blocked: true }))
    await expect(
      t.mutation(internal.admin.purgeRetiredAgent, { agentId: operator, reason: "x" })
    ).rejects.toThrow(/operator identity cannot be purged/)
  })

  it("refuses while any contribution is still live", async () => {
    const t = setup()
    const { retired } = await fixture(t)
    const liveId = await contribution(t, retired, false)
    await expect(
      t.mutation(internal.admin.purgeRetiredAgent, { agentId: retired, reason: "x" })
    ).rejects.toThrow(/Suppress 1 remaining contribution/)
    await t.run(async (ctx) => {
      expect(await ctx.db.get(retired)).not.toBeNull()
      expect(await ctx.db.get(liveId)).not.toBeNull()
    })
  })
})
