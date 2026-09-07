import { describe, expect, it, vi, afterEach } from "vitest"
import { allowIndexing, contentDescription, pageMetadata } from "../lib/seo"
import robots from "../app/robots"
import { openapi } from "../lib/openapi"
import { readSchemas } from "../lib/read-contracts"
import { siteUrl } from "../lib/site"
import { GET as guide } from "../app/for-agents.md/route"
import { GET as fullGuide } from "../app/llms-full.txt/route"
import { agentGuide } from "../lib/agent-guide"

vi.mock("../lib/analytics/server", () => ({ trackDocument: vi.fn() }))

afterEach(() => vi.unstubAllEnvs())

describe("crawler and citation discovery", () => {
  it("uses readable article text instead of Markdown URLs, images, and code", () => {
    const text = contentDescription(
      "# Evidence\n\nA **supported** [claim](https://example.org/a-very-long-url) with `data`.\n\n![Unrelated photo](https://example.org/photo.jpg)\n\n```js\nsecretCode()\n```\n"
    )
    expect(text).toBe("Evidence A supported claim with data.")
    expect(
      contentDescription(
        "- First finding\n- Second finding\n\n> A note.\n>\n> Another note."
      )
    ).toBe("First finding Second finding A note. Another note.")
    expect(
      contentDescription(
        "An informative description that is longer than the available snippet.",
        40
      )
    ).toBe("An informative description that is…")
  })

  it("keeps preview and fixture deployments out of public indexes", () => {
    expect(allowIndexing({ VERCEL_ENV: "production" })).toBe(true)
    expect(allowIndexing({ APP_ENV: "production" })).toBe(true)
    expect(
      allowIndexing({ VERCEL_ENV: "preview", APP_ENV: "production" })
    ).toBe(false)
    expect(allowIndexing({ APP_ENV: "test" })).toBe(false)
    expect(allowIndexing({})).toBe(false)
    vi.stubEnv("VERCEL_ENV", "preview")
    expect(robots()).toEqual({ rules: { userAgent: "*", disallow: "/" } })
  })

  it("allows production search and retrieval while preserving the training opt-out", () => {
    vi.stubEnv("VERCEL_ENV", "production")
    vi.stubEnv("BLOCK_TRAINING_CRAWLERS", "true")
    const result = robots()
    expect(result.sitemap).toBe(`${siteUrl}/sitemap.xml`)
    expect(result.rules).toEqual([
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/account", "/api/auth/", "/mcp"],
      },
      {
        userAgent: ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot"],
        disallow: "/",
      },
    ])
  })

  it("keeps social previews specific to the page and on the configured origin", () => {
    const metadata = pageMetadata("Research", "Find cited evidence.", "/wiki")
    expect(metadata.alternates?.canonical).toBe("/wiki")
    expect(metadata.openGraph).toMatchObject({
      title: "Research",
      description: "Find cited evidence.",
      url: `${siteUrl}/wiki`,
    })
    expect(metadata.twitter).toMatchObject({
      card: "summary_large_image",
      title: "Research",
      description: "Find cited evidence.",
    })
  })

  it("serves the same guide in HTML's source text and Markdown, with a canonical link", async () => {
    const response = guide()
    expect(response.headers.get("Link")).toBe(
      `<${siteUrl}/for-agents>; rel="canonical"`
    )
    expect(response.headers.get("X-Robots-Tag")).toBe("noindex, follow")
    expect(await response.text()).toContain(agentGuide)
    const full = await fullGuide().text()
    expect(full).toContain(agentGuide)
    expect(full).toContain("## Wiki editorial process")
  })

  it("describes every REST read operation and preserves public/authenticated boundaries", () => {
    vi.stubEnv("PLACE_ENABLED", "true")
    const schema = openapi()
    const operations = Object.values(schema.paths).flatMap((path) => {
      const value = path as {
        get?: { operationId: string; description: string; security?: unknown }
      }
      return value.get ? [value.get] : []
    })
    for (const name of Object.keys(readSchemas)) {
      const operation = operations.find(
        (op) => op.operationId === `get_${name}`
      )!
      expect(operation.description.length).toBeGreaterThan(50)
      expect(Boolean(operation.security)).toBe(
        ["work", "billing", "notifications", "jury_work", "personal_blocks", "place_wallet", "integrity_evidence", "purchases", "purchase"].includes(name) || name.startsWith("private_")
      )
    }
    expect(schema.externalDocs.url).toBe(`${siteUrl}/for-agents`)
  })
})
