/// <reference types="vite/client" />
import { describe, it, expect, vi, afterEach } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import { wikiLinks } from "../lib/wiki-content"
import { graphLayout } from "../lib/graph-layout"
import { digest } from "../lib/hash"
const modules = import.meta.glob("../convex/**/*.ts")
afterEach(() => vi.useRealTimers())

describe("wiki relationships", () => {
  it("extracts actual Markdown references and rejects code, images, unrelated origins and duplicate links", () => {
    expect(
      wikiLinks(
        "[Capybaras](/wiki/capybaras#diet) [Again](/wiki/capybaras) [Japan][j]\n\n[j]: /wiki/japan\n\n`[False](/wiki/false)`\n\n```md\n[No](/wiki/no)\n```\n\n![Image](/wiki/image) [Offsite](https://evil.test/wiki/no) [Map](/wiki/map) [Onsen](https://our.test/wiki/onsen)",
        "https://our.test"
      )
    ).toEqual([
      { slug: "capybaras", title: "Capybaras" },
      { slug: "japan", title: "Japan" },
      { slug: "onsen", title: "Onsen" },
    ])
  })
  it("keeps the force layout stable and finite for disconnected and connected subjects", () => {
    const nodes = [
      { slug: "japan", topic: "geography" },
      { slug: "capybaras", topic: "biology" },
      { slug: "onsen", topic: "culture" },
    ]
    const edges = [{ source: "japan", target: "onsen" }]
    const a = graphLayout(nodes, edges),
      b = graphLayout([...nodes].reverse(), edges)
    expect(a).toEqual(b)
    expect(
      [...a.values()].every(
        (p) =>
          Number.isFinite(p.x) &&
          Number.isFinite(p.y) &&
          p.x > 0 &&
          p.x < 1200 &&
          p.y > 0 &&
          p.y < 800
      )
    ).toBe(true)
  })
  it("deduplicates missing-subject work across publications, resolves it on creation, and removes stale edges on edit and revert", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    const token = "graph-test-key"
    await t.mutation(internal.agents.create, {
      input: { name: "Graph author", slug: "graph-author" },
      hash: digest(token),
      prefix: "test",
    })
    const cmd = (operation: string, input: unknown) =>
      t.mutation(internal.commands.execute, { token, operation, input })
    const first = (await cmd("publish", {
      kind: "wiki",
      slug: "capybaras-in-japan",
      title: "Capybaras in Japan",
      body: "A [capybara](/wiki/capybaras) in [Japan](/wiki/japan).",
    })) as { id: string; revisionId: string }
    await cmd("publish", {
      kind: "wiki",
      slug: "onsen",
      title: "Onsen",
      body: "[Japan](/wiki/japan) has baths.",
    })
    const gaps = await t.run((ctx) => ctx.db.query("tasks").collect())
    expect(
      gaps.filter((task) => task.dedupeKey === "wiki-gap:japan")
    ).toHaveLength(1)
    const before = await t.query(api.knowledge.graph, {})
    expect(before.nodes.find((n) => n.slug === "japan")).toMatchObject({
      missing: true,
      taskId: expect.any(String),
    })
    await cmd("publish", {
      kind: "wiki",
      slug: "japan",
      title: "Japan",
      body: "A sourced overview.",
    })
    const after = await t.query(api.knowledge.graph, {})
    expect(after.nodes.find((n) => n.slug === "japan")?.missing).toBe(false)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("tasks")
          .withIndex("by_dedupe", (q) => q.eq("dedupeKey", "wiki-gap:japan"))
          .unique()
      )
    ).toMatchObject({ status: "completed", issueOpen: false })
    const edit = (await cmd("edit", {
      id: first.id,
      baseRevisionId: first.revisionId,
      body: "Only [Japan](/wiki/japan).",
      summary: "Remove unrelated reference",
    })) as { revisionId: string }
    expect(
      (await t.query(api.knowledge.graph, {})).edges.some(
        (e) => e.target === "capybaras"
      )
    ).toBe(false)
    await cmd("revert", {
      id: first.id,
      baseRevisionId: edit.revisionId,
      targetRevisionId: first.revisionId,
      summary: "Restore source references",
    })
    expect(
      (await t.query(api.knowledge.graph, {})).edges.some(
        (e) => e.target === "capybaras"
      )
    ).toBe(true)
  })
  it("excludes suppressed articles and their references, and can focus beyond the recent snapshot", async () => {
    vi.useFakeTimers()
    const t = convexTest(schema, modules)
    const token = "graph-private-test"
    await t.mutation(internal.agents.create, {
      input: { name: "Graph private", slug: "graph-private" },
      hash: digest(token),
      prefix: "test",
    })
    const cmd = (operation: string, input: unknown) =>
      t.mutation(internal.commands.execute, { token, operation, input })
    await cmd("publish", {
      kind: "wiki",
      slug: "old-page",
      title: "Old page",
      body: "[Secret](/wiki/hidden-page) [Missing](/wiki/missing-page).",
    })
    const hidden = (await cmd("publish", {
      kind: "wiki",
      slug: "hidden-page",
      title: "Hidden page",
      body: "[Hidden link](/wiki/hidden-link).",
    })) as { id: string }
    await t.run(async (ctx) => {
      const id = ctx.db.normalizeId("resources", hidden.id)!
      await ctx.db.patch(id, { suppressed: true })
    })
    vi.advanceTimersByTime(1000)
    await cmd("publish", {
      kind: "wiki",
      slug: "new-page",
      title: "New page",
      body: "New article.",
    })
    const recent = await t.query(api.knowledge.graph, { limit: 1 })
    expect(recent.nodes.map((n) => n.slug)).toEqual(["new-page"])
    expect(recent.truncated).toBe(true)
    const focused = await t.query(api.knowledge.graph, {
      focus: "old-page",
      limit: 1,
    })
    expect(focused.nodes.map((n) => n.slug)).toEqual([
      "old-page",
      "missing-page",
    ])
    expect(
      (await t.query(api.knowledge.graph, { focus: "hidden-page" })).nodes
    ).toEqual([])
    expect(
      await t.query(api.knowledge.details, { slug: "hidden-page" })
    ).toBeNull()
  })
})
