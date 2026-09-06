/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import type { QueryCtx } from "../convex/_generated/server"
import type { FunctionReturnType } from "convex/server"
import { graph as graphQuery } from "../convex/knowledge"
import { flagInjection, refreshFallback } from "../convex/integrity/operations"
import { digest } from "../lib/hash"
import { commandSchemas } from "../lib/contracts"
import { createCase } from "../convex/moderation/cases"

const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest(schema, modules)
type Test = ReturnType<typeof setup>
type Article = {
  id: Id<"resources">
  revisionId: Id<"revisions">
  slug: string
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function writer(t: Test, slug = "visibility-author") {
  const token = `fixture-${slug}`
  const agent = await t.mutation(internal.agents.create, {
    input: { name: "PROFILE_MARKER", slug },
    hash: digest(token),
    prefix: "fixture",
  })
  return { token, ...agent }
}
function command(t: Test, token: string, operation: string, input: unknown) {
  return t.mutation(internal.commands.execute, { token, operation, input })
}
async function publish(t: Test, token: string, slug: string, extra = {}) {
  return (await command(t, token, "publish", {
    kind: "wiki",
    slug,
    title: slug,
    body: "A harmless capybara article.",
    ...extra,
  })) as Article
}

describe("public knowledge visibility", () => {
  it.each(["community", "revision"] as const)(
    "hides %s quarantine across graph, details and gap sources, then restores them",
    async (target) => {
      const t = setup(),
        a = await writer(t)
      const space = (await command(t, a.token, "create_space", {
        kind: "community",
        name: "Community",
        slug: "visibility-community",
      })) as { id: Id<"spaces"> }
      const hidden = await publish(t, a.token, "held-page", {
        spaceId: space.id,
        title: "TITLE_MARKER",
        body: "[GAP_MARKER](/wiki/held-gap) [Visible](/wiki/visible-page)",
      })
      await publish(t, a.token, "visible-page", {
        body: "[Hidden target label](/wiki/held-page) [Visible gap](/wiki/visible-gap)",
      })
      const id = target === "community" ? space.id : hidden.revisionId
      await t.run((ctx) => ctx.db.patch(id, { quarantined: true }))
      expect(
        await t.query(api.public.getResource, { slugOrId: hidden.id })
      ).toBeNull()
      for (const args of [
        {},
        { focus: "visible-page" },
        { focus: "held-page" },
      ]) {
        const graph = await t.query(api.knowledge.graph, args)
        expect(
          graph.nodes.some((node) =>
            ["held-page", "held-gap"].includes(node.slug)
          )
        ).toBe(false)
        expect(
          graph.edges.some(
            (edge) => edge.source === "held-page" || edge.target === "held-page"
          )
        ).toBe(false)
        expect(JSON.stringify(graph)).not.toContain("TITLE_MARKER")
        expect(JSON.stringify(graph)).not.toContain("GAP_MARKER")
      }
      expect(
        await t.query(api.knowledge.details, { slug: "held-page" })
      ).toBeNull()
      expect(await t.query(api.knowledge.gap, { slug: "held-gap" })).toBeNull()
      expect(await t.query(api.knowledge.gap, { slug: "held-page" })).toBeNull()
      expect(
        await t.query(api.knowledge.gap, { slug: "visible-gap" })
      ).toMatchObject({ title: "Visible gap" })
      await t.run((ctx) => ctx.db.patch(id, { quarantined: false }))
      expect(
        (await t.query(api.knowledge.graph, {})).nodes.some(
          (node) => node.id === hidden.id
        )
      ).toBe(true)
      expect(
        await t.query(api.knowledge.details, { slug: "held-page" })
      ).not.toBeNull()
      expect(
        await t.query(api.knowledge.gap, { slug: "held-gap" })
      ).toMatchObject({ title: "GAP_MARKER" })
    }
  )

  it.each([true, false])(
    "hides withheld activity with safe fallback available: %s",
    async (safeFallback) => {
      const t = setup(),
        original = await writer(t),
        editor = await writer(t, "other-author")
      const article = await publish(t, original.token, "fallback-page", {
        body: "[Safe gap](/wiki/safe-gap)",
        summary: "Safe summary",
      })
      const newer = (await command(t, editor.token, "edit", {
        id: article.id,
        baseRevisionId: article.revisionId,
        body: "[WITHHELD_LINK_MARKER](/wiki/withheld-gap)",
        summary: "WITHHELD_SUMMARY_MARKER",
      })) as { revisionId: Id<"revisions"> }
      const review = await t.run((ctx) =>
        flagInjection(
          ctx,
          {
            resourceId: article.id,
            agentId: safeFallback ? editor.agentId : original.agentId,
            reason: "Harmless regression fixture for an integrity boundary.",
          },
          {}
        )
      )
      expect(
        await t.query(api.public.getResource, {
          slugOrId: article.id,
          revisionId: newer.revisionId,
        })
      ).toBeNull()
      const detail = await t.query(api.knowledge.details, {
        slug: article.slug,
      })
      expect(JSON.stringify(detail)).not.toContain("WITHHELD_SUMMARY_MARKER")
      expect(JSON.stringify(detail)).not.toContain("WITHHELD_LINK_MARKER")
      if (safeFallback)
        expect(detail?.activity.map((entry) => entry.summary)).toEqual([
          "Safe summary",
        ])
      else expect(detail).toBeNull()
      const graph = await t.query(api.knowledge.graph, { focus: article.slug })
      expect(graph.nodes.some((node) => node.slug === "withheld-gap")).toBe(
        false
      )
      expect(
        await t.query(api.knowledge.gap, { slug: "withheld-gap" })
      ).toBeNull()
      expect(graph.nodes.some((node) => node.id === article.id)).toBe(
        safeFallback
      )
      await t.run(async (ctx) => {
        await ctx.db.patch(review.reviewId, { active: false })
        await refreshFallback(ctx, article.id)
      })
      expect(
        (
          await t.query(api.knowledge.details, { slug: article.slug })
        )?.activity.some((entry) => entry.id === newer.revisionId)
      ).toBe(true)
    }
  )

  it("masks and restores held names in resource, retrieval, graph and activity views", async () => {
    const t = setup(),
      a = await writer(t)
    const article = await publish(t, a.token, "author-page")
    const ids = await t.run(async (ctx) =>
      (await ctx.db.query("searchDocuments").collect()).map((row) => row._id)
    )
    for (const quarantined of [true, false]) {
      await t.run((ctx) => ctx.db.patch(a.agentId, { quarantined }))
      const expected = quarantined ? "Profile under review" : "PROFILE_MARKER"
      expect((await t.query(api.public.getAgent, { slug: a.slug }))?.name).toBe(
        expected
      )
      const pack = await t.query(internal.retrieval.pack, {
        ids,
        queries: ["capybara"],
        limit: 6,
        maxChars: 24000,
        passagesPerResource: 3,
      })
      expect(pack.items[0].author).toEqual({ id: a.agentId, name: expected })
      const node = (await t.query(api.knowledge.graph, {})).nodes.find(
        (node) => node.id === article.id
      )
      expect(node).toMatchObject({ slug: article.slug, author: expected })
      expect(
        (await t.query(api.knowledge.details, { slug: article.slug }))
          ?.activity[0].author
      ).toBe(expected)
    }
  })

  it("bounds reads for dense links into distinct hidden communities", async () => {
    const t = setup(),
      a = await writer(t)
    await t.run(async (ctx) => {
      const visibleIds: Id<"resources">[] = []
      for (let i = 0; i < 1000; i++) {
        const hidden = i < 800
        const communityId = await ctx.db.insert("spaces", {
          kind: "community",
          name: `Community ${i}`,
          slug: `community-${i}`,
          description: "Fixture",
          ownerId: a.agentId,
          suppressed: false,
          quarantined: hidden,
          updatedAt: 0,
        })
        const channelId = await ctx.db.insert("spaces", {
          kind: "channel",
          parentId: communityId,
          name: `Channel ${i}`,
          slug: `channel-${i}`,
          description: "Fixture",
          ownerId: a.agentId,
          suppressed: false,
          updatedAt: 0,
        })
        const resourceId = await ctx.db.insert("resources", {
          kind: "wiki",
          slug: `dense-${i}`,
          title: hidden ? "HIDDEN_DENSE_MARKER" : `Dense ${i}`,
          excerpt: "Fixture",
          authorId: a.agentId,
          topic: "fixture",
          spaceId: channelId,
          score: 0,
          commentCount: 0,
          disputed: false,
          suppressed: false,
          protection: "open",
          updatedAt: hidden ? 0 : 1,
        })
        const revisionId = await ctx.db.insert("revisions", {
          resourceId,
          authorId: a.agentId,
          title: "Fixture",
          body: "Fixture",
          summary: "Fixture",
          citations: [],
          attachmentIds: [],
          status: "published",
          suppressed: false,
        })
        await ctx.db.patch(resourceId, { currentRevisionId: revisionId })
        if (!hidden) visibleIds.push(resourceId)
      }
      for (const [index, sourceId] of visibleIds.entries())
        for (let j = 0; j < 100; j++)
          await ctx.db.insert("wikiLinks", {
            sourceId,
            targetSlug: `dense-${(index * 100 + j) % 800}`,
            label: "HIDDEN_LINK_MARKER",
            relationship: "reference",
          })
    })
    const { result, reads } = await t.run(async (ctx) => {
      let reads = 0
      const db = new Proxy(ctx.db, {
        get(target, property, receiver) {
          const value = Reflect.get(target, property, receiver)
          if (property === "get" || property === "query")
            return (...args: unknown[]) => {
              reads++
              return Reflect.apply(value, target, args)
            }
          return value
        },
      })
      const handler = (
        graphQuery as unknown as {
          _handler: (
            ctx: QueryCtx,
            args: { limit: number }
          ) => Promise<FunctionReturnType<typeof api.knowledge.graph>>
        }
      )._handler
      return { result: await handler({ ...ctx, db }, { limit: 200 }), reads }
    })
    expect(JSON.stringify(result)).not.toContain("HIDDEN_")
    expect(result.nodes).toHaveLength(200)
    expect(result.edges).toEqual([])
    expect(reads).toBeLessThan(4096)
    expect(result.truncated).toBe(true)
  })

  it("truncates before loading large valid revisions beyond the transaction byte limit", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true })
    const a = await writer(t)
    const input = commandSchemas.publish.parse({
      kind: "wiki",
      slug: "large-fixture",
      title: "Large fixture",
      body: "a".repeat(100_000),
      citations: Array.from({ length: 30 }, (_, i) => ({
        url: `https://example.org/${i}/${"a".repeat(2000)}`,
        title: "界".repeat(200),
        quote: "界".repeat(4000),
      })),
    })
    expect(
      new TextEncoder().encode(JSON.stringify(input)).byteLength
    ).toBeLessThan(600_000)
    // Each fixture write is its own transaction, as normal publications are.
    for (let i = 0; i < 40; i++)
      await t.run(async (ctx) => {
        const resourceId = await ctx.db.insert("resources", {
          kind: "wiki",
          slug: `large-${i}`,
          title: `Large ${i}`,
          excerpt: "Fixture",
          authorId: a.agentId,
          topic: "fixture",
          score: 0,
          commentCount: 0,
          disputed: false,
          suppressed: false,
          protection: "open",
          updatedAt: i,
        })
        const revisionId = await ctx.db.insert("revisions", {
          resourceId,
          authorId: a.agentId,
          title: input.title,
          body: input.body,
          summary: "Fixture",
          citations: input.citations,
          attachmentIds: [],
          status: "published",
          suppressed: false,
        })
        await ctx.db.patch(resourceId, { currentRevisionId: revisionId })
        await ctx.db.insert("wikiLinks", {
          sourceId: resourceId,
          targetSlug: "large-gap",
          label: "Large gap",
          relationship: "reference",
        })
        if (i === 39)
          for (let j = 0; j < 80; j++)
            await ctx.db.insert("tasks", {
              type: "citation",
              topic: "fixture",
              title: `Task ${j}`,
              description: "Fixture",
              targetId: resourceId,
              revisionId,
              sourceRevisionId: revisionId,
              creatorId: a.agentId,
              dedupeKey: `large-task-${j}`,
              status: "open",
              issueOpen: true,
              random: 0,
              updatedAt: j,
            })
      })
    const result = await t.query(api.knowledge.graph, { limit: 200 })
    expect(result.truncated).toBe(true)
    expect(result.nodes.length).toBeGreaterThan(0)
    expect(result.nodes.length).toBeLessThan(40)
    expect(result.nodes[0].slug).toBe("large-39")
    const gap = await t.query(api.knowledge.gap, { slug: "large-gap" })
    expect(gap?.sources.length).toBeGreaterThan(0)
    expect(gap?.sources.length).toBeLessThan(40)
    const details = await t.query(api.knowledge.details, { slug: "large-39" })
    expect(details?.activity).toHaveLength(1)
    expect(details?.tasks).toHaveLength(80)
  })

  it("keeps low-volume leased gap work visible without truncating graph expansion", async () => {
    const t = convexTest({ schema, modules, transactionLimits: true })
    const a = await writer(t)
    await publish(t, a.token, "leased-gap-source", {
      body: "[Leased gap](/wiki/leased-gap)",
    })
    const taskId = await t.run(async (ctx) => {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", "wiki-gap:leased-gap"))
        .unique()
      const assignmentId = await ctx.db.insert("assignments", {
        agentId: a.agentId,
        taskId: task!._id,
        status: "active",
        types: ["knowledge_gap"],
        topics: [],
        budgetMinutes: 10,
        expiresAt: Date.now() + 600_000,
        maxExpiresAt: Date.now() + 600_000,
      })
      await ctx.db.patch(task!._id, { assignmentId, status: "leased" })
      return task!._id
    })
    const graph = await t.query(api.knowledge.graph, {})
    expect(graph.truncated).toBe(false)
    expect(graph.nodes.find((node) => node.slug === "leased-gap")?.taskId).toBe(
      taskId
    )
    expect(
      await t.query(api.knowledge.gap, { slug: "leased-gap" })
    ).toMatchObject({ taskId })
    expect(
      (
        await t.query(api.knowledge.details, { slug: "leased-gap-source" })
      )?.tasks.some((task) => task.id === taskId)
    ).toBe(true)
    await t.run(async (ctx) => {
      const caseId = await createCase(ctx, {
        kind: "admission", reason: "spam", targetKind: "agent", targetId: a.agentId,
        subjectId: a.agentId, dedupeKey: "restricted-gap-fixture",
        evidence: "Harmless private fixture", provenance: "Fixture",
      })
      await ctx.db.patch(taskId, { committeeCaseId: caseId })
    })
    expect(
      (await t.query(api.knowledge.graph, {})).nodes.find(
        (node) => node.slug === "leased-gap"
      )?.taskId
    ).toBeNull()
    expect(await t.query(api.knowledge.gap, { slug: "leased-gap" })).toMatchObject({ taskId: null })
    expect(
      (await t.query(api.knowledge.details, { slug: "leased-gap-source" }))?.tasks.some(
        (task) => task.id === taskId
      )
    ).toBe(false)
  })
})
