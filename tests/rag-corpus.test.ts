/// <reference types="vite/client" />
import { readFileSync } from "node:fs"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"

vi.mock("../lib/embeddings", () => ({
  embeddingsConfigured: () => false,
  embed: vi.fn(),
  embedMany: vi.fn(),
}))
const modules = import.meta.glob("../convex/**/*.ts")
const manifest = JSON.parse(
  readFileSync(
    new URL("../content/wiki/manifest.json", import.meta.url),
    "utf8"
  )
) as {
  articles: { slug: string; title: string; topic: string }[]
  sources: Record<string, string>
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

it("retrieves labeled answer spans from the actual wiki corpus in a single research call", async () => {
  const t = convexTest(schema, modules),
    token = "corpus-test-key"
  await t.mutation(internal.agents.create, {
    input: { name: "Corpus tester", slug: "corpus-tester" },
    hash: digest(token),
    prefix: "test",
  })
  for (const article of manifest.articles) {
    const body = readFileSync(
      new URL(`../content/wiki/${article.slug}.md`, import.meta.url),
      "utf8"
    )
    const citations = Object.entries(manifest.sources)
      .filter(([url]) => body.includes(url))
      .map(([url, title]) => ({ url, title }))
    await t.mutation(internal.commands.execute, {
      token,
      operation: "publish",
      input: { kind: "wiki", ...article, body, citations },
    })
  }
  const result = await t.action(api.semantic.retrieve, {
    query: "Where are capybaras native?",
    queries: [
      "When did capybara bathing begin at Izu Shaboten Zoo?",
      "What is the difference between onsen sentō and rotenburo?",
    ],
    kind: "wiki",
    maxChars: 24000,
  })
  const evidence = (title: string) =>
    result.items
      .find((item) => item.title === title)
      ?.passages.map((p) => p.text)
      .join("\n") ?? ""
  expect(evidence("Capybaras")).toContain("South America")
  expect(evidence("Izu Shaboten Zoo")).toContain("1982")
  expect(evidence("Onsen")).toContain("public bathhouse")
  expect(evidence("Onsen")).toContain("open-air bath")
  expect(
    result.items.every(
      (item) =>
        item.citations.length > 0 && item.revisionUrl.includes(item.revisionId)
    )
  ).toBe(true)
  expect(result.contextChars).toBeLessThanOrEqual(24000)
})
