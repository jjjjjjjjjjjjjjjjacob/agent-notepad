/// <reference types="vite/client" />
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import {
  chunkMarkdown,
  excerptRange,
  fuseRanks,
  MAX_SEARCH_CHUNKS,
} from "../lib/retrieval"
import { embed, embedMany, embeddingsConfigured } from "../lib/embeddings"
import { readSchemas } from "../lib/read-contracts"
import { digest } from "../lib/hash"
import { EMBEDDING_MODEL } from "../lib/embedding-config"

vi.mock("../lib/embeddings", () => ({
  embeddingsConfigured: vi.fn(() => false),
  embed: vi.fn(),
  embedMany: vi.fn(),
}))
const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest(schema, modules)
type Test = ReturnType<typeof setup>
type Resource = {
  id: Id<"resources">
  revisionId: Id<"revisions">
  slug: string
}
const vector = (x = 1, y = 0) => [x, y, ...Array<number>(382).fill(0)]

async function writer(t: Test) {
  const token = "rag-test-key"
  const agent = await t.mutation(internal.agents.create, {
    input: { name: "RAG tester", slug: "rag-tester" },
    hash: digest(token),
    prefix: "test",
  })
  return { token, ...agent }
}
async function publish(
  t: Test,
  token: string,
  body: string,
  slug: string,
  extra: object = {}
) {
  return (await t.mutation(internal.commands.execute, {
    token,
    operation: "publish",
    input: {
      kind: "wiki",
      slug,
      title: slug.replaceAll("-", " "),
      body,
      topic: "animals",
      ...extra,
    },
  })) as Resource
}
async function chunks(t: Test, id: Id<"resources">) {
  return t.run((ctx) =>
    ctx.db
      .query("searchDocuments")
      .withIndex("by_resource", (q) => q.eq("resourceId", id))
      .collect()
  )
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(embeddingsConfigured).mockReturnValue(false)
  vi.mocked(embed).mockReset().mockResolvedValue(vector())
  vi.mocked(embedMany)
    .mockReset()
    .mockImplementation((texts) => Promise.all(texts.map(embed)))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe("retrieval chunks and ranking", () => {
  it.each([
    "x".repeat(100_000),
    "A paragraph about water.\n\n".repeat(4000).slice(0, 100_000),
    "## Heading\nTiny section\n".repeat(4500).slice(0, 100_000),
  ])(
    "covers the entire maximum-length document with bounded overlapping chunks",
    (body) => {
      const ranges = chunkMarkdown(body)
      expect(ranges.length).toBeLessThanOrEqual(MAX_SEARCH_CHUNKS)
      expect(ranges[0].start).toBe(0)
      expect(ranges.at(-1)?.end).toBe(body.length)
      for (const [index, range] of ranges.entries()) {
        expect(range.end - range.start).toBeLessThanOrEqual(1200)
        if (index) {
          expect(range.start).toBeLessThanOrEqual(ranges[index - 1].end)
          expect(range.end).toBeGreaterThan(ranges[index - 1].end)
        }
      }
    }
  )
  it("retains heading ancestry and ignores fenced example headings", () => {
    const body = `# Biology\n${"Introduction. ".repeat(125)}\n\n## Habitat\n${"Wetland. ".repeat(240)}\n\n\`\`\`md\n# Fake heading\n\`\`\`\n${"More wetlands. ".repeat(250)}`
    const ranges = chunkMarkdown(body)
    expect(
      ranges.some(
        (r) => r.heading === "Biology > Habitat" && r.section === "habitat"
      )
    ).toBe(true)
    expect(ranges.some((r) => r.heading?.includes("Fake"))).toBe(false)
    expect(chunkMarkdown("## **Hot**-spring `care`\nDetails")[0].section).toBe(
      "hot-spring-care"
    )
  })
  it("finds answers after the old 1200-character cutoff", () => {
    const text = `${"Background material. ".repeat(200)}The amber code is 7349. ${"More material. ".repeat(100)}`
    const range = excerptRange(text, ["What is the amber code?"], 1200)
    expect(text.slice(range.start, range.end)).toContain("7349")
  })
  it("fuses by passage without replacing a strong hit with another passage", () => {
    const first = { id: "a:1", text: "exact answer" }
    const ranked = fuseRanks([
      [first, { id: "b:1", text: "other" }],
      [
        { id: "a:2", text: "other section" },
        { id: "a:1", text: "replacement" },
      ],
    ])
    expect(ranked[0].text).toBe("exact answer")
    expect(ranked).toHaveLength(3)
  })
})

describe("one-call retrieval", () => {
  it("returns several exact answer passages and numbered sources for related questions", async () => {
    const t = setup(),
      a = await writer(t)
    const body = `# Capybaras\n${"Introductory background. ".repeat(90)}\n\n## Diet\nCapybaras eat grasses and aquatic plants. [1]\n${"Feeding details. ".repeat(170)}\n\n## Habitat\nCapybaras live near rivers and wetlands. [2]\n${"Habitat details. ".repeat(120)}`
    const article = await publish(t, a.token, body, "capybara-guide", {
      citations: [
        { url: "https://example.org/diet", title: "Diet study" },
        { url: "https://example.org/habitat", title: "Habitat study" },
      ],
    })
    const result = await t.action(api.semantic.retrieve, {
      query: "What do capybaras eat?",
      queries: ["capybara habitat wetlands"],
      kind: "wiki",
      topic: "animals",
    })
    const item = result.items.find((i) => i.id === article.id)!
    expect(item.revisionId).toBe(article.revisionId)
    expect(item.passages.length).toBeGreaterThan(1)
    const text = item.passages.map((p) => p.text).join("\n")
    expect(text).toContain("grasses and aquatic plants")
    expect(text).toContain("rivers and wetlands")
    for (const p of item.passages)
      expect(body.slice(p.start, p.end)).toBe(p.text)
    expect(item.citations.map((c) => c.number)).toEqual([1, 2])
    expect(item.revisionUrl).toContain(article.revisionId)
    expect(item.license).toBe("CC-BY-SA-4.0")
    expect(result.mode).toBe("keyword")
    expect(result.notice).toContain("not configured")
  })
  it("shares the budget across sources and never exceeds serialized maxChars", async () => {
    const t = setup(),
      a = await writer(t)
    for (let i = 0; i < 4; i++)
      await publish(
        t,
        a.token,
        `Capybara habitat ${i}. ${"A wetland observation. ".repeat(280)}`,
        `habitat-${i}`
      )
    const result = await t.action(api.semantic.retrieve, {
      query: "capybara habitat",
      maxChars: 8000,
    })
    expect(result.items.length).toBeGreaterThan(1)
    expect(result.contextChars).toBe(JSON.stringify(result.items).length)
    expect(result.contextChars).toBeLessThanOrEqual(8000)
    expect(result.truncated).toBe(true)
    expect(result.returnedPassages).toBeGreaterThan(1)
  })
  it("excludes stale, suppressed, and hidden-community evidence", async () => {
    const t = setup(),
      a = await writer(t)
    const article = await publish(t, a.token, "Old zebracode 123.", "versioned")
    const old = (await chunks(t, article.id))[0]
    const edit = (await t.mutation(internal.commands.execute, {
      token: a.token,
      operation: "edit",
      input: {
        id: article.id,
        baseRevisionId: article.revisionId,
        body: "New zebracode 456.",
        summary: "Correct code",
      },
    })) as { revisionId: Id<"revisions"> }
    // Simulate an old candidate still arriving from a vector index during a revision race.
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...data } = old
      void _id
      void _creationTime
      await ctx.db.insert("searchDocuments", data)
    })
    const result = await t.action(api.semantic.retrieve, { query: "zebracode" })
    expect(result.items).toHaveLength(1)
    expect(result.items[0].revisionId).toBe(edit.revisionId)
    expect(JSON.stringify(result.items)).not.toContain("Old zebracode 123.")
    await t.run((ctx) => ctx.db.patch(edit.revisionId, { suppressed: true }))
    expect(
      (await t.action(api.semantic.retrieve, { query: "zebracode" })).items
    ).toEqual([])
    expect(await t.query(api.search.keyword, { query: "zebracode" })).toEqual(
      []
    )
    await t.run((ctx) => ctx.db.patch(edit.revisionId, { suppressed: false }))
    await t.run(async (ctx) => {
      const spaceId = await ctx.db.insert("spaces", {
        name: "Hidden",
        slug: "hidden",
        kind: "community",
        ownerId: a.agentId,
        description: "Hidden",
        suppressed: true,
        updatedAt: Date.now(),
      })
      await ctx.db.patch(article.id, { spaceId })
    })
    expect(
      (await t.action(api.semantic.retrieve, { query: "zebracode" })).items
    ).toEqual([])
  })
  it("returns the matching region of a legacy chunk before backfill", async () => {
    const t = setup(),
      a = await writer(t)
    const body = `${"Background. ".repeat(350)}The amber code is 7349. ${"Afterword. ".repeat(30)}`
    const article = await publish(t, a.token, body, "legacy-article")
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("searchDocuments").collect())
        await ctx.db.delete(row._id)
      await ctx.db.insert("searchDocuments", {
        resourceId: article.id,
        revisionId: article.revisionId,
        kind: "wiki",
        title: "Legacy",
        topic: "animals",
        text: `Legacy\n${body}`,
      })
    })
    const result = await t.action(api.semantic.retrieve, {
      query: "amber code",
    })
    expect(result.items[0].passages[0].text).toContain("7349")
    expect(result.items[0].passages[0].truncated).toBe(true)
    const small = await t.action(api.semantic.retrieve, {
      query: "amber code",
      maxChars: 4000,
    })
    expect(small.items[0].passages[0].text).toContain("7349")
    expect(small.contextChars).toBeLessThanOrEqual(4000)
    expect(small.truncated).toBe(true)
    expect(
      (await t.query(api.search.keyword, { query: "amber code" }))[0].passage
    ).toContain("7349")
  })
  it("validates budgets, query batches, and unsupported knowledge kinds", () => {
    for (const input of [
      { query: " " },
      { query: "a", queries: ["b", "c", "d", "e"] },
      { query: "a", maxChars: 80001 },
      { query: "a", kind: "message" },
    ])
      expect(readSchemas.retrieve.safeParse(input).success).toBe(false)
  })
})

describe("semantic retrieval and indexing", () => {
  it("retrieves a semantic-only answer despite higher-ranked out-of-topic and wrong-kind matches", async () => {
    const t = setup(),
      a = await writer(t)
    const expected = await publish(
      t,
      a.token,
      "A large rodent bathes in a hot spring.",
      "thermal-rodents"
    )
    const others = [
      await publish(t, a.token, "Unrelated software article.", "computing", {
        topic: "software",
      }),
      await publish(t, a.token, "Unrelated animal notebook.", "animal-note", {
        kind: "note",
      }),
    ]
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("searchDocuments").collect())
        await ctx.db.patch(row._id, {
          embeddingBge:
            row.resourceId === expected.id ? vector(0.9, 0.1) : vector(),
        })
      // More noise than the vector candidate limit catches post-filter regressions.
      const noise = (await ctx.db.query("searchDocuments").collect()).find(
        (r) => r.resourceId === others[0].id
      )!
      const { _id, _creationTime, ...data } = noise
      void _id
      void _creationTime
      for (let i = 0; i < 85; i++) await ctx.db.insert("searchDocuments", data)
    })
    vi.mocked(embeddingsConfigured).mockReturnValue(true)
    const result = await t.action(api.semantic.retrieve, {
      query: "capybara onsen",
      kind: "wiki",
      topic: "animals",
    })
    expect(result.mode).toBe("hybrid")
    expect(result.items.map((i) => i.id)).toEqual([expected.id])
    expect(result.items[0].passages[0].text).toContain("hot spring")
  })
  it("preserves keyword results on provider failure and batches distinct queries once", async () => {
    const t = setup(),
      a = await writer(t)
    await publish(t, a.token, "Capybara habitat wetlands.", "capybara")
    vi.mocked(embeddingsConfigured).mockReturnValue(true)
    vi.mocked(embed).mockRejectedValue(new Error("Provider down"))
    const result = await t.action(api.semantic.retrieve, {
      query: "capybara",
      queries: ["habitat", "capybara"],
    })
    expect(result.items).toHaveLength(1)
    expect(result.mode).toBe("keyword")
    expect(result.notice).toContain("failed")
    expect(embedMany).toHaveBeenCalledExactlyOnceWith(
      ["capybara", "habitat"],
      "query"
    )
  })
  it("budgets and processes more than 30 chunks and only retries missing embeddings", async () => {
    const t = setup(),
      a = await writer(t)
    const resource = await publish(
      t,
      a.token,
      "x".repeat(100_000),
      "large-article"
    )
    const rows = await chunks(t, resource.id)
    expect(rows.length).toBeGreaterThan(30)
    const job = await t.run((ctx) =>
      ctx.db
        .query("jobs")
        .filter((q) => q.eq(q.field("kind"), "embedding"))
        .first()
    )
    await t.mutation(internal.jobs.saveEmbedding, {
      id: rows[0]._id,
      revisionId: resource.revisionId,
      embedding: vector(),
      model: EMBEDDING_MODEL,
    })
    const started = await t.mutation(internal.jobs.start, { jobId: job!._id })
    expect(started?.chunks).toHaveLength(rows.length - 1)
    const budget = await t.run((ctx) =>
      ctx.db
        .query("limits")
        .withIndex("by_bucket", (q) => q.eq("bucket", "external:embedding"))
        .unique()
    )
    expect(budget?.count).toBe(rows.length - 1)
    await t.mutation(internal.jobs.saveEmbedding, {
      id: rows[1]._id,
      revisionId: resource.revisionId,
      embedding: Array(384).fill(NaN),
      model: EMBEDDING_MODEL,
    })
    expect((await chunks(t, resource.id))[1].embeddingBge).toBeUndefined()
  })
  it("enforces the query budget before requesting a batch of embeddings", async () => {
    const t = setup(),
      a = await writer(t)
    await publish(t, a.token, "Capybara habitat wetlands.", "query-budget")
    await t.run((ctx) =>
      ctx.db.insert("limits", {
        bucket: "semantic_search",
        count: 120,
        resetAt: Date.now() + 60000,
      })
    )
    vi.mocked(embeddingsConfigured).mockReturnValue(true)
    const result = await t.action(api.semantic.retrieve, {
      query: "capybara",
      queries: ["habitat"],
    })
    expect(result.mode).toBe("keyword")
    expect(result.items).toHaveLength(1)
    expect(embedMany).not.toHaveBeenCalled()
  })
  it("backfills legacy indexes once without changing the published revision", async () => {
    const t = setup(),
      a = await writer(t)
    const article = await publish(
      t,
      a.token,
      "# Capybara\nWetland research.",
      "upgrade"
    )
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("searchDocuments").collect())
        await ctx.db.patch(row._id, {
          indexVersion: undefined,
          scope: undefined,
        })
    })
    const first = await t.mutation(internal.retrieval.backfill, {})
    expect(first.indexed).toBe(1)
    expect((await chunks(t, article.id))[0]).toMatchObject({
      indexVersion: 3,
      scope: "wiki:animals",
      revisionId: article.revisionId,
    })
    expect((await t.mutation(internal.retrieval.backfill, {})).indexed).toBe(0)
    expect(
      (await t.query(api.public.getResource, { slugOrId: article.id }))
        ?.revision.id
    ).toBe(article.revisionId)
  })
  it("requeues blocked BGE indexing without duplicating active jobs or accepting Titan vectors", async () => {
    const t = setup(),
      a = await writer(t)
    const article = await publish(
      t,
      a.token,
      "Capybaras use warm baths in winter.",
      "provider-migration"
    )
    const [chunk] = await chunks(t, article.id)
    await t.run(async (ctx) => {
      await ctx.db.patch(chunk._id, { embedding: [1, ...Array(1023).fill(0)] })
      for (const job of await ctx.db.query("jobs").collect())
        if (job.kind === "embedding")
          await ctx.db.patch(job._id, { status: "blocked" })
    })
    await t.mutation(internal.jobs.saveEmbedding, {
      id: chunk._id,
      revisionId: article.revisionId,
      embedding: vector(),
      model: "titan",
    })
    expect((await chunks(t, article.id))[0].embeddingBge).toBeUndefined()
    expect(await t.mutation(internal.retrieval.backfill, {})).toMatchObject({
      indexed: 0,
      queued: 1,
    })
    expect(await t.mutation(internal.retrieval.backfill, {})).toMatchObject({
      indexed: 0,
      queued: 0,
    })
    const job = await t.run((ctx) =>
      ctx.db
        .query("jobs")
        .filter((q) =>
          q.and(
            q.eq(q.field("kind"), "embedding"),
            q.eq(q.field("status"), "pending")
          )
        )
        .first()
    )
    expect(
      (await t.mutation(internal.jobs.start, { jobId: job!._id }))?.chunks
    ).toHaveLength(1)
  })
})
