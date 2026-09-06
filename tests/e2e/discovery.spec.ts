import { test, expect } from "@playwright/test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import AxeBuilder from "@axe-core/playwright"
import { mkdir } from "node:fs/promises"

const base = "http://127.0.0.1:4242"
test.beforeEach(async ({ request }) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
})

test("agents can discover and read the guide without JavaScript or authentication", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    await page.goto("/")
    await page.getByRole("link", { name: "Agent guide", exact: true }).click()
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(
      "A shared knowledge base for AI agents"
    )
    await expect(
      page.getByRole("heading", {
        name: "Search and cite knowledge",
        exact: true,
      })
    ).toBeVisible()
    await expect(
      page.getByRole("heading", {
        name: "Make a useful contribution",
        exact: true,
      })
    ).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${base}/for-agents`
    )
    await expect(
      page.locator('link[rel="alternate"][type="text/markdown"]')
    ).toHaveAttribute("href", `${base}/for-agents.md`)
    await expect(
      page.locator('meta[property="og:description"]')
    ).toHaveAttribute("content", /search cited knowledge/)
    const sitemap = await (await request.get("/sitemaps/static.xml")).text()
    for (const path of ["/for-agents", "/chat", "/wiki/map"])
      expect(sitemap).toContain(`${base}${path}`)
    for (const path of [
      "/for-agents.md",
      "/llms.txt",
      "/llms-full.txt",
      "/skill.md",
      "/indexes?kind=wiki",
    ]) {
      const response = await request.get(path)
      expect(response.ok(), path).toBe(true)
    }
    const image = await request.get("/opengraph-image")
    expect(image.ok()).toBe(true)
    expect(image.headers()["content-type"]).toContain("image/png")
    expect(
      (await request.get("/for-agents")).headers()["x-robots-tag"]
    ).toContain("noindex")
  } finally {
    await context.close()
  }
})

test("MCP clients discover documentation and choose a public retrieval tool", async () => {
  const client = new Client({ name: "discovery-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
  )
  try {
    const { tools } = await client.listTools()
    expect(
      tools.find((tool) => tool.name === "get_search")?.description
    ).toContain("before researching a subject")
    expect(
      tools.find((tool) => tool.name === "get_channels")?.description
    ).toContain("conversation")
    const { resources } = await client.listResources()
    const guide = resources.find((resource) => resource.name === "agent-guide")!
    expect(guide.uri).toBe(`${base}/for-agents.md`)
    const content = await client.readResource({ uri: guide.uri })
    expect(content.contents[0]).toMatchObject({
      mimeType: "text/markdown",
      text: expect.stringContaining("## Search and cite knowledge"),
    })
    const article = await client.callTool({
      name: "get_resource",
      arguments: { id: "source-provenance" },
    })
    expect(article.isError).not.toBe(true)
    expect(article.structuredContent).toMatchObject({
      data: { canonicalUrl: `${base}/wiki/source-provenance` },
    })
  } finally {
    await client.close()
  }
})

test("article metadata points to matching revisions and the guide fits mobile", async ({
  page,
  request,
}) => {
  const { data: item } = await (
    await request.get("/api/v1/resources/source-provenance")
  ).json()
  await page.goto(`/wiki/source-provenance?revision=${item.revision.id}`)
  const alternate = page.locator('link[rel="alternate"][type="text/markdown"]')
  const href = await alternate.getAttribute("href")
  expect(new URL(href!).searchParams.get("revision")).toBe(item.revision.id)
  expect(await (await request.get(href!)).text()).toContain(item.revision.body)
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute(
    "content",
    /noindex/
  )
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute(
    "content",
    "article"
  )
  await mkdir(".artifacts/screenshots", { recursive: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto("/for-agents")
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  expect(
    (await new AxeBuilder({ page }).include("#page-content").analyze())
      .violations
  ).toEqual([])
  await page.screenshot({
    path: ".artifacts/screenshots/agent-guide-mobile.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto("/")
  await page.screenshot({
    path: ".artifacts/screenshots/discovery-home.png",
    fullPage: true,
  })
})
