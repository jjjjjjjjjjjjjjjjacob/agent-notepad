/// <reference types="vite/client" />
import { readFileSync, mkdirSync, writeFileSync } from "node:fs"
import { expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import { replaceSearchDocuments } from "../convex/lib/searchIndex"
import { EMBEDDING_MODEL } from "../lib/embedding-config"
import manifest from "../content/wiki/manifest.json"

const modules = import.meta.glob("../convex/**/*.ts")
// Deliberately opt-in: regular unit tests never download a model or call a service.
it.skipIf(process.env.RUN_EMBEDDING_INTEGRATION !== "1")(
  "indexes the real wiki corpus with FastEmbed and retrieves cited answers using real vectors",
  async () => {
    if (
      !process.env.EMBEDDING_SERVICE_URL ||
      !process.env.EMBEDDING_SERVICE_TOKEN
    )
      throw new Error(
        "Configure a running embedding service for this integration test."
      )
    vi.useFakeTimers()
    try {
      const t = convexTest(schema, modules)
      // Seed published records directly. This exercises indexing/retrieval; registration
      // and publishing authorization have their own tests and require no external services here.
      const jobs = await t.run(async (ctx) => {
        const authorId = await ctx.db.insert("agents", {
          name: "Embedding integration",
          slug: "embedding-integration",
          bio: "Test fixture",
          capabilities: [],
          topics: [],
          role: "editor",
          blocked: false,
          contributionCount: 0,
          reviewCount: 0,
          updatedAt: Date.now(),
        })
        const jobs = []
        for (const article of manifest.articles) {
          const body = readFileSync(
            new URL(`../content/wiki/${article.slug}.md`, import.meta.url),
            "utf8"
          )
          const resourceId = await ctx.db.insert("resources", {
            ...article,
            kind: "wiki",
            excerpt: body.slice(0, 200),
            authorId,
            score: 0,
            commentCount: 0,
            disputed: false,
            suppressed: false,
            protection: "open",
            updatedAt: Date.now(),
          })
          const revisionId = await ctx.db.insert("revisions", {
            resourceId,
            authorId,
            title: article.title,
            body,
            summary: "Integration fixture",
            citations: Object.entries(manifest.sources)
              .filter(([url]) => body.includes(url))
              .map(([url, title]) => ({ url, title })),
            attachmentIds: [],
            status: "published",
            suppressed: false,
          })
          await ctx.db.patch(resourceId, { currentRevisionId: revisionId })
          await replaceSearchDocuments(
            ctx,
            (await ctx.db.get(resourceId))!,
            (await ctx.db.get(revisionId))!
          )
          jobs.push(
            await ctx.db.insert("jobs", {
              kind: "embedding",
              resourceId,
              revisionId,
              status: "pending",
              attempts: 0,
              nextAt: Date.now(),
            })
          )
        }
        return jobs
      })
      for (const jobId of jobs)
        await t.action(internal.background.run, { jobId })
      const index = await t.run(async (ctx) => ({
        jobs: await ctx.db.query("jobs").collect(),
        chunks: await ctx.db.query("searchDocuments").collect(),
      }))
      expect(index.jobs.every((job) => job.status === "completed")).toBe(true)
      expect(
        index.chunks.every(
          (chunk) =>
            chunk.embeddingModel === EMBEDDING_MODEL &&
            chunk.embeddingBge?.length === 384
        )
      ).toBe(true)
      const result = await t.action(api.semantic.retrieve, {
        query: "Where are capybaras native?",
        queries: [
          "When did capybara bathing begin at Izu Shaboten Zoo?",
          "What is the difference between onsen sentō and rotenburo?",
        ],
        kind: "wiki",
        maxChars: 24000,
      })
      expect(result.mode).toBe("hybrid")
      expect(result.notice).toBeNull()
      const text = result.items
        .flatMap((item) => item.passages)
        .map((p) => p.text)
        .join("\n")
      for (const answer of [
        "South America",
        "1982",
        "public bathhouse",
        "open-air bath",
      ])
        expect(text).toContain(answer)
      expect(result.contextChars).toBeLessThanOrEqual(24000)
      expect(
        result.items.every(
          (item) =>
            item.citations.length && item.revisionUrl.includes(item.revisionId)
        )
      ).toBe(true)
      // Isolate a natural-language paraphrase whose words do not occur in either
      // fixture. A hit here must come from real embeddings, not keyword fallback.
      const fixture = await t.run(async (ctx) => {
        const template = (await ctx.db.query("resources").first())!
        const targets = [
          {
            slug: "vector-bathing",
            title: "Winter bathing",
            body: "Capybaras soak in hot spring baths at Izu Shaboten Zoo in winter.",
          },
          {
            slug: "vector-computing",
            title: "Database development",
            body: "Software engineers compile programs and investigate database errors.",
          },
        ]
        const jobs = []
        for (const target of targets) {
          const resourceId = await ctx.db.insert("resources", {
            kind: "wiki",
            slug: target.slug,
            title: target.title,
            excerpt: target.body,
            topic: "semantic-fixture",
            authorId: template.authorId,
            score: 0,
            commentCount: 0,
            disputed: false,
            suppressed: false,
            protection: "open",
            updatedAt: Date.now(),
          })
          const revisionId = await ctx.db.insert("revisions", {
            resourceId,
            authorId: template.authorId,
            title: target.title,
            body: target.body,
            summary: "Semantic fixture",
            citations: [],
            attachmentIds: [],
            status: "published",
            suppressed: false,
          })
          await ctx.db.patch(resourceId, { currentRevisionId: revisionId })
          await replaceSearchDocuments(
            ctx,
            (await ctx.db.get(resourceId))!,
            (await ctx.db.get(revisionId))!
          )
          jobs.push(
            await ctx.db.insert("jobs", {
              kind: "embedding",
              resourceId,
              revisionId,
              status: "pending",
              attempts: 0,
              nextAt: Date.now(),
            })
          )
        }
        return jobs
      })
      for (const jobId of fixture)
        await t.action(internal.background.run, { jobId })
      const question = {
        query:
          "Where can the giant rodents warm themselves during cold weather?",
        kind: "wiki",
        topic: "semantic-fixture",
      }
      expect(await t.query(internal.search.candidates, question)).toHaveLength(
        0
      )
      const vectorOnly = await t.action(api.semantic.retrieve, {
        ...question,
        limit: 1,
      })
      expect(vectorOnly.mode).toBe("hybrid")
      expect(vectorOnly.notice).toBeNull()
      expect(vectorOnly.items[0]?.title).toBe("Winter bathing")
      expect(vectorOnly.items[0]?.passages[0].text).toContain(
        "Izu Shaboten Zoo"
      )
      mkdirSync(".artifacts", { recursive: true })
      writeFileSync(
        ".artifacts/embeddings-integration.json",
        JSON.stringify(
          {
            model: EMBEDDING_MODEL,
            indexedChunks: index.chunks.length,
            completedJobs: index.jobs.length,
            contextChars: result.contextChars,
            returnedPassages: result.returnedPassages,
            titles: result.items.map((item) => item.title),
            vectorOnlyKeywordCandidates: 0,
            vectorOnlyTitles: vectorOnly.items.map((item) => item.title),
            answerSpans: [
              "South America",
              "1982",
              "public bathhouse",
              "open-air bath",
            ],
          },
          null,
          2
        )
      )
    } finally {
      vi.useRealTimers()
    }
  },
  120000
)
