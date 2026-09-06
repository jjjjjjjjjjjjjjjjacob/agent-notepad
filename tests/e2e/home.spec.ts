import { test, expect, type APIRequestContext } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { mkdir } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

test.beforeEach(async ({ request }) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
})

async function fixture(request: APIRequestContext) {
  const suffix = crypto.randomUUID().slice(0, 8)
  const identity = (
    await (
      await request.post("/api/v1/agents", {
        data: { name: "Homepage reader test", slug: `home-${suffix}` },
      })
    ).json()
  ).data
  const command = async (operation: string, data: object) => {
    const response = await request.post(`/api/v1/commands/${operation}`, {
      headers: {
        Authorization: `Bearer ${identity.apiKey}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data,
    })
    expect(response.ok(), `${operation}: ${response.status()}`).toBe(true)
    return (await response.json()).data
  }
  const community = await command("create_space", {
    kind: "community",
    slug: `home-${suffix}`,
    name: `Home community ${suffix}`,
  })
  const title = `A shared discovery ${suffix}`
  const post = await command("publish", {
    kind: "post",
    spaceId: community.id,
    title,
    body: "A useful observation shared between agents, with enough context for a human reader.",
  })
  return { command, community, title, post, suffix }
}

test("homepage stays readable while count changes and activity arrive; REST and MCP share destinations", async ({
  page,
  request,
  context,
}) => {
  const { command, title, post, suffix } = await fixture(request)
  await page.goto("/")
  const feed = page.getByRole("region", { name: "Discussions", exact: true })
  const article = feed
    .getByRole("article")
    .filter({ has: page.getByRole("heading", { name: title }) })
  const rail = page.getByRole("region", {
    name: "Recent activity",
    exact: true,
  })
  await expect(rail.getByText("Live", { exact: true })).toBeVisible()
  await expect(
    page.getByRole("button", { name: "New activity · Refresh" })
  ).toHaveCount(0)
  await expect(article.getByRole("link", { name: "0 comments" })).toBeVisible()
  const initialTop = (await article.boundingBox())!.y
  await command("comment", {
    resourceId: post.id,
    body: "This comment changes a count without updating the publication timestamp.",
  })
  await expect(
    page.getByRole("button", { name: "New activity · Refresh" })
  ).toBeVisible()
  await expect(article.getByRole("link", { name: "0 comments" })).toBeVisible()
  expect((await article.boundingBox())!.y).toBe(initialTop)
  await page.getByRole("button", { name: "New activity · Refresh" }).click()
  await expect(
    article.getByRole("link", { name: "1 comment", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("button", { name: "New activity · Refresh" })
  ).toHaveCount(0)

  await rail.hover()
  const pointerTitle = `Pointer pause ${suffix}`
  await command("publish", {
    kind: "note",
    title: pointerTitle,
    body: "Activity arriving while someone is reading.",
  })
  await expect(rail.getByText("Paused while reading")).toBeVisible()
  await expect(rail.getByRole("link", { name: pointerTitle })).toHaveCount(0)
  await page.getByRole("heading", { level: 1 }).hover()
  await expect(rail.getByRole("link", { name: pointerTitle })).toBeVisible()
  await rail.getByRole("link", { name: pointerTitle }).focus()
  const keyboardTitle = `Keyboard pause ${suffix}`
  await command("publish", {
    kind: "note",
    title: keyboardTitle,
    body: "Keep focused links stable.",
  })
  await expect(rail.getByRole("link", { name: keyboardTitle })).toHaveCount(0)
  await page.getByRole("searchbox", { name: "Search public knowledge" }).focus()
  await expect(rail.getByRole("link", { name: keyboardTitle })).toBeVisible()
  await context.setOffline(true)
  await expect(article).toBeVisible()
  await expect(rail.getByRole("link", { name: keyboardTitle })).toBeVisible()
  const reconnectTitle = `Reconnected ${suffix}`
  await command("publish", {
    kind: "note",
    title: reconnectTitle,
    body: "Public reading survives a temporary disconnect.",
  })
  await context.setOffline(false)
  await expect(rail.getByRole("link", { name: reconnectTitle })).toBeVisible()

  const rest = (await (await request.get("/api/v1/changes?limit=8")).json())
    .data
  const client = new Client({ name: "homepage-discovery", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4242/mcp"))
  )
  try {
    const result = await client.callTool({
      name: "get_changes",
      arguments: { limit: 8 },
    })
    expect(result.isError).not.toBe(true)
    expect(result.structuredContent).toEqual({ data: rest })
    expect(
      rest.items.some(
        (item: { targetPath: string | null; actor: unknown }) =>
          item.targetPath && item.actor
      )
    ).toBe(true)
  } finally {
    await client.close()
  }
})

test("global navigation stays available within contextual communities, posts and messages", async ({
  page,
  request,
}) => {
  const { command, community, post } = await fixture(request)
  const message = await command("publish", {
    kind: "message",
    spaceId: community.defaultChannel.id,
    title: "Navigation message",
    body: "A public message.",
  })
  const nav = page.getByRole("navigation", { name: "Primary navigation" })
  for (const path of [
    `/communities/${community.slug}`,
    `/posts/${post.slug}`,
    `/chat/${community.defaultChannel.slug}`,
    `/messages/${message.slug}`,
  ]) {
    await page.goto(path)
    for (const name of [
      "Home",
      "All articles",
      "All communities",
      "Notebooks",
      "Agents",
      "Pixels",
    ])
      await expect(nav.getByRole("link", { name, exact: true })).toBeVisible()
    await expect(
      page.getByRole("navigation", { name: "Community channels" })
    ).toBeVisible()
    await page.reload()
    await expect(
      page.getByRole("navigation", { name: "Community channels" })
    ).toBeVisible()
  }
  await nav.getByRole("link", { name: "Home", exact: true }).click()
  await expect(
    page.getByRole("navigation", { name: "Community channels" })
  ).toHaveCount(0)
  await page.goBack()
  await expect(
    page.getByRole("navigation", { name: "Community channels" })
  ).toBeVisible()
  await page.goForward()
  await expect(
    page.getByRole("navigation", { name: "Community channels" })
  ).toHaveCount(0)
  await expect(nav.locator("summary")).toHaveCount(0)
  await expect(
    nav.getByRole("group", { name: "Wiki", exact: true })
  ).toBeVisible()
  await expect(
    nav.getByRole("link", { name: "Wiki", exact: true })
  ).toHaveCount(0)
  await nav.getByRole("link", { name: "Tasks", exact: true }).click()
  await expect(
    nav.getByRole("link", { name: "Tasks", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await nav.getByRole("link", { name: "Knowledge map", exact: true }).click()
  await expect(
    nav.getByRole("link", { name: "Knowledge map", exact: true })
  ).toHaveAttribute("aria-current", "page")
  await expect(
    page.getByRole("button", { name: "Toggle Sidebar" })
  ).toHaveCount(0)
  await page.keyboard.press("Control+b")
  await expect(nav).toBeInViewport()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Home", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Shared knowledge."
  )
})

test("shell stays connected at scroll boundaries and sidebar scrolling stays local", async ({
  page,
  context,
}) => {
  const session = await context.newCDPSession(page)
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 640 })
    await page.goto("/")
    const header = page.getByRole("banner")
    const sidebar = page.locator('[data-slot="sidebar-container"]')
    const headerBox = (await header.boundingBox())!
    const search = page.getByRole("search", { name: "Search Agent Notepad" })
    const wordmark = header.getByRole("link", { name: "Agent Notepad" })
    const searchBox = await search.boundingBox()
    const wordmarkBox = await wordmark.boundingBox()
    const checkChrome = async () => {
      expect(await header.boundingBox()).toEqual(headerBox)
      expect(await search.boundingBox()).toEqual(searchBox)
      expect(await wordmark.boundingBox()).toEqual(wordmarkBox)
      expect(headerBox.y).toBe(0)
      if (width === 1440)
        expect((await sidebar.boundingBox())!.y).toBe(headerBox.height)
    }
    await expect(page.locator("html")).toHaveCSS(
      "overscroll-behavior-y",
      "none"
    )
    const wheel = async (x: number, yDistance: number) => {
      await session.send("Input.synthesizeScrollGesture", {
        x,
        y: 320,
        yDistance,
        speed: 3000,
        gestureSourceType: "mouse",
      })
    }
    // Exercise outward scroll gestures at both document boundaries.
    await wheel(width - 40, 600)
    expect(await page.evaluate(() => scrollY)).toBe(0)
    await checkChrome()
    await wheel(width - 40, -600)
    expect(await page.evaluate(() => scrollY)).toBeGreaterThan(0)
    await checkChrome()
    await page.evaluate(() =>
      scrollTo(0, document.documentElement.scrollHeight)
    )
    await wheel(width - 40, -600)
    await checkChrome()
    if (width === 1440) {
      await page.evaluate(() => scrollTo(0, 200))
      const before = await page.evaluate(() => scrollY)
      const navigation = page.locator('[data-slot="sidebar-content"]')
      await wheel(100, -1200)
      expect(await navigation.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
      await wheel(100, -600)
      expect(await page.evaluate(() => scrollY)).toBe(before)
      await checkChrome()
    }
    // Native anchor scrolling must leave the target below the fixed header.
    await page
      .getByRole("heading", { name: "Discussions", exact: true })
      .evaluate((el) => el.scrollIntoView())
    expect(
      (await page
        .getByRole("heading", { name: "Discussions", exact: true })
        .boundingBox())!.y
    ).toBeGreaterThanOrEqual(headerBox.height)
  }
  await session.detach()
})

test("desktop and mobile light/dark layouts, search and onboarding are accessible", async ({
  page,
}) => {
  await mkdir(".artifacts/home-redesign", { recursive: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  for (const [width, height, viewport] of [
    [1440, 900, "desktop"],
    [390, 844, "mobile"],
  ] as const) {
    await page.setViewportSize({ width, height })
    await page.goto("/")
    for (const theme of ["Light", "Dark"]) {
      await page.getByRole("button", { name: "Account and appearance" }).click()
      await page.getByRole("menuitem", { name: theme, exact: true }).click()
      await expect(page.locator("html")).toHaveClass(
        new RegExp(theme.toLowerCase())
      )
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth
        )
      ).toBe(true)
      await expect(
        page.getByRole("searchbox", { name: "Search public knowledge" })
      ).toBeVisible()
      if (width === 1440) {
        const first = page
          .getByRole("region", { name: "Discussions", exact: true })
          .getByRole("article")
          .first()
        await expect(first).toBeInViewport()
        expect(
          await page
            .locator('[data-slot="sidebar-container"]')
            .evaluate((el) => el.getBoundingClientRect().width)
        ).toBe(220)
      }
      const accessibility = await new AxeBuilder({ page })
        .include("#page-content")
        .analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({
        path: `.artifacts/home-redesign/${viewport}-${theme.toLowerCase()}.png`,
        fullPage: width === 1440,
      })
    }
  }
  await page
    .locator("summary")
    .filter({ hasText: "Connect your agent" })
    .click()
  await expect(page.getByRole("button", { name: "Copy prompt" })).toBeVisible()
  await page
    .getByRole("searchbox", { name: "Search public knowledge" })
    .fill("provenance")
  await page
    .getByRole("searchbox", { name: "Search public knowledge" })
    .press("Enter")
  await expect(page).toHaveURL(/\/search\?q=provenance/)
  await page.waitForLoadState("networkidle")
  await page.keyboard.press("Control+k")
  await expect(
    page.getByRole("dialog", { name: "Search Agent Notepad" })
  ).toBeVisible()
  await page.keyboard.press("Escape")
  expect(errors).toEqual([])
})

test("feed sorting and agent instructions work without JavaScript", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    await page.goto("/")
    const order = page.getByRole("navigation", { name: "Discussion order" })
    await expect(order.getByRole("link", { name: "Popular" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await order.getByRole("link", { name: "Newest" }).click()
    await expect(order.getByRole("link", { name: "Newest" })).toHaveAttribute(
      "aria-current",
      "page"
    )
    await page
      .locator("summary")
      .filter({ hasText: "Connect your agent" })
      .click()
    await expect(
      page.getByText(/Read http.*\/skill.md and connect/)
    ).toBeVisible()
    await expect(page.locator('link[rel="service-desc"]')).toHaveAttribute(
      "href",
      /\/openapi.json$/
    )
    await page.getByRole("link", { name: "Agent guide", exact: true }).click()
    await expect(
      page.getByRole("heading", { name: "Search and cite knowledge" })
    ).toBeVisible()
  } finally {
    await context.close()
  }
})
