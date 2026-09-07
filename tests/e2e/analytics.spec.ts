import { test, expect, type Page, type BrowserContext } from "@playwright/test"
import { gunzipSync } from "node:zlib"
import path from "node:path"
import AxeBuilder from "@axe-core/playwright"

type Captured = { event: string; properties: Record<string, unknown> }
const token = "phc_analytics_verification_only"
async function intercept(context: BrowserContext) {
  const events: Captured[] = [],
    requests: string[] = []
  // The SDK intentionally excludes WebDriver bots; simulate a real browser for collection tests.
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false })
    Object.defineProperty(navigator, "userAgentData", { get: () => undefined })
  })
  await context.route("https://*.posthog.com/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url())
    requests.push(url.pathname)
    if (url.pathname.endsWith(".js")) {
      const name = path.basename(url.pathname)
      if (
        [
          "recorder.js",
          "recorder-v2.js",
          "lazy-recorder.js",
          "posthog-recorder.js",
        ].includes(name)
      )
        return route.fulfill({
          path: path.resolve("node_modules/posthog-js/dist", name),
          contentType: "application/javascript",
        })
      return route.fulfill({ body: "", contentType: "application/javascript" })
    }
    if (
      url.pathname.includes("flags") ||
      url.pathname.includes("config") ||
      url.pathname.includes("decide")
    )
      return route.fulfill({
        json: {
          featureFlags: {},
          sessionRecording: {
            endpoint: "/s/",
            sampleRate: 0.1,
            minimumDurationMilliseconds: 0,
          },
          autocapture_opt_out: false,
        },
      })
    const buffer = request.postDataBuffer()
    if (buffer) {
      let body = buffer.toString()
      if (
        url.searchParams.get("compression") === "gzip-js" ||
        buffer[0] === 0x1f
      )
        body = gunzipSync(buffer).toString()
      else if (body.startsWith("data="))
        body = Buffer.from(
          new URLSearchParams(body).get("data")!,
          "base64"
        ).toString()
      const parsed = JSON.parse(body)
      events.push(
        ...(Array.isArray(parsed) ? parsed : (parsed.batch ?? [parsed]))
      )
    }
    await route.fulfill({ json: { status: 1 } })
  })
  return { events, requests }
}
async function accepted(page: Page, replay = false, sampled = true) {
  await page.addInitScript(
    ({ token, replay, sampled }) => {
      localStorage.setItem(
        "an-analytics-consent-v1",
        JSON.stringify({ version: 1, analytics: true, replay })
      )
      // Fixed SDK sessions exercise its real deterministic 10% sampling, including reloads.
      localStorage.setItem(
        `ph_${token}_posthog`,
        JSON.stringify({
          distinct_id: "analytics-browser-test",
          $device_id: "analytics-browser-test",
          $sesid: [
            Date.now(),
            sampled
              ? "00000000-0000-4000-8000-000000000060"
              : "00000000-0000-4000-8000-000000000000",
            Date.now(),
          ],
        })
      )
    },
    { token, replay, sampled }
  )
}
test.beforeEach(async ({ request }) => {
  expect((await (await request.get("/health")).json()).environment).toBe("test")
})

test("consent gates all SDK requests and withdrawal clears identifiers", async ({
  page,
  context,
}) => {
  const { events, requests } = await intercept(context)
  await page.goto("/wiki")
  await expect(
    page.getByRole("button", { name: "Decline", exact: true })
  ).toBeVisible()
  expect(
    (
      await new AxeBuilder({ page })
        .include('[aria-labelledby="analytics-consent-title"]')
        .analyze()
    ).violations
  ).toEqual([])
  await page.getByRole("button", { name: "Decline", exact: true }).click()
  await page.getByRole("link", { name: "Agents", exact: true }).first().click()
  await expect(page).toHaveURL(/\/agents$/)
  expect(requests).toEqual([])
  await page
    .getByRole("button", { name: "Analytics preferences", exact: true })
    .click()
  await expect(page.getByRole("dialog")).toHaveCSS("opacity", "1")
  expect(
    (await new AxeBuilder({ page }).include('[role="dialog"]').analyze())
      .violations
  ).toEqual([])
  await page.getByLabel("Usage analytics", { exact: true }).check()
  await page.getByRole("button", { name: "Save preferences" }).click()
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(1)
  await page
    .getByRole("button", { name: "Analytics preferences", exact: true })
    .click()
  await page.getByRole("button", { name: "Decline all" }).click()
  const count = events.length
  await page.goto("/wiki")
  await expect(
    page.getByRole("button", { name: "Analytics preferences", exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((k) => k.startsWith("ph_"))
    )
  ).toEqual([])
  expect(events).toHaveLength(count)
})

test("search events correlate across native navigation without leaking query text or duplicating views", async ({
  page,
  context,
}) => {
  const { events } = await intercept(context)
  await accepted(page)
  await page.goto("/wiki")
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(1)
  const secret = "private_search_token_731"
  await page
    .getByRole("search", { name: "Search Agent Notepad" })
    .getByRole("searchbox")
    .fill(secret)
  await page
    .getByRole("search", { name: "Search Agent Notepad" })
    .getByRole("searchbox")
    .press("Enter")
  await expect(page).toHaveURL(new RegExp("/search\\?q=" + secret))
  await expect
    .poll(
      () => events.filter((e) => e.event === "search_results_viewed").length
    )
    .toBe(1)
  expect(events.filter((e) => e.event === "$pageview")).toHaveLength(2)
  const submitted = events.find((e) => e.event === "search_submitted")!
  const results = events.find((e) => e.event === "search_results_viewed")!
  expect(submitted.properties.search_id).toBe(results.properties.search_id)
  expect(results.properties.result_count).toBe(
    await page.locator("[data-analytics-rank]").count()
  )
  expect(JSON.stringify(events)).not.toContain(secret)
  await page
    .getByRole("link", { name: "All articles", exact: true })
    .last()
    .click()
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(3)
})

test("sampled replay masks search text, attributes, and account transitions", async ({
  page,
  context,
}) => {
  const { events } = await intercept(context)
  await accepted(page, true)
  await page.goto("/search?q=private_replay_term_731")
  await expect
    .poll(
      async () => {
        // Auth resolution and recorder loading may finish after the initial render.
        await page
          .getByRole("heading", {
            name: "Search public knowledge",
            exact: true,
          })
          .click()
        return events.filter((e) => e.event === "$snapshot").length
      },
      {
        timeout: 30000,
      }
    )
    .toBeGreaterThan(0)
  await page
    .getByRole("search", { name: "Search Agent Notepad" })
    .getByRole("searchbox")
    .fill("private_input_731")
  // Keep this synthetic privacy sentinel separate from the URL's token field.
  const privateLink = "private_link_731"
  const linkQuery = new URLSearchParams({
    linkingCode: privateLink,
  })
  await page.goto(`/account?${linkQuery}`)
  await expect
    .poll(() =>
      events.some(
        (e) =>
          e.event === "$pageview" &&
          String(e.properties.$pathname).startsWith("/account")
      )
    )
    .toBe(true)
  await expect(
    page.getByRole("button", { name: "Analytics preferences", exact: true })
  ).toBeVisible()
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("private_email_731@example.com")
  await page.goto("/wiki")
  await expect
    .poll(
      async () => {
        await page
          .getByRole("heading", { name: "All articles", exact: true, level: 1 })
          .click()
        return events.filter((e) => e.event === "$snapshot").length
      },
      {
        timeout: 30000,
      }
    )
    .toBeGreaterThan(1)
  await page
    .getByRole("button", { name: "Account and appearance", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Account", exact: true }).click()
  await expect(page).toHaveURL(/\/account$/)
  await page
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("private_spa_email_731@example.com")
  await page.getByRole("link", { name: "Agents", exact: true }).first().click()
  await expect(page).toHaveURL(/\/agents$/)
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBeGreaterThanOrEqual(5)
  expect(
    events
      .filter((e) => e.event === "$snapshot")
      .every((e) => !String(e.properties.$pathname).startsWith("/account"))
  ).toBe(true)
  const raw = JSON.stringify(decodeSnapshots(events))
  for (const secret of [
    "private_replay_term_731",
    "private_input_731",
    "private_link_731",
    "private_email_731",
    "private_spa_email_731",
  ])
    expect(raw).not.toContain(secret)
})

test("sampled-out sessions remain unrecorded across reloads", async ({
  page,
  context,
}) => {
  const { events } = await intercept(context)
  await accepted(page, true, false)
  await page.goto("/wiki")
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(1)
  await page.reload()
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(2)
  expect(events.filter((e) => e.event === "$snapshot")).toEqual([])
})

test("result selection carries rank and reading milestones occur once per view", async ({
  page,
  context,
  request,
}) => {
  const { events } = await intercept(context)
  await accepted(page)
  const suffix = crypto.randomUUID().slice(0, 8)
  const registration = await request.post("/api/v1/agents", {
    data: { name: "Analytics fixture", slug: `analytics-${suffix}` },
  })
  expect(registration.status()).toBe(201)
  const { apiKey } = (await registration.json()).data
  const publication = await request.post("/api/v1/commands/publish", {
    headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": suffix },
    data: {
      kind: "note",
      title: `Reading fixture ${suffix}`,
      topic: `analytics-${suffix}`,
      body: Array.from(
        { length: 8 },
        (_, i) =>
          `## Section ${i + 1}\n\n${"Public reading fixture. ".repeat(180)}`
      ).join("\n\n"),
    },
  })
  expect(publication.ok()).toBe(true)
  const resource = (await publication.json()).data
  await page.goto(`/search?q=Reading&topic=analytics-${suffix}`)
  const resultLink = page.locator(
    `[data-analytics-resource-id="${resource.id}"][data-analytics-rank]`
  )
  await expect(resultLink).toBeVisible()
  await expect
    .poll(() => events.some((e) => e.event === "search_results_viewed"))
    .toBe(true)
  const rank = Number(await resultLink.getAttribute("data-analytics-rank"))
  await resultLink.click()
  await expect
    .poll(() => events.some((e) => e.event === "search_result_clicked"))
    .toBe(true)
  const selected = events.find((e) => e.event === "search_result_clicked")!
  expect(selected.properties).toMatchObject({
    rank,
    resource_id: resource.id,
    search_id: events.find((e) => e.event === "search_results_viewed")!
      .properties.search_id,
  })
  await expect(page.locator("[data-analytics-reading] .markdown")).toBeVisible()
  await page
    .locator("[data-analytics-reading] .markdown h2")
    .last()
    .scrollIntoViewIfNeeded()
  await page
    .locator("[data-analytics-reading] .markdown p")
    .last()
    .evaluate((element) => element.scrollIntoView({ block: "end" }))
  await expect
    .poll(() => events.filter((e) => e.event === "reading_progress").length)
    .toBe(4)
  await page.evaluate(() => {
    window.scrollTo(0, 0)
    location.hash = "section-1"
  })
  await page
    .locator("[data-analytics-reading] .markdown h2")
    .last()
    .scrollIntoViewIfNeeded()
  await page.getByRole("link", { name: "Agents", exact: true }).first().click()
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(3)
  expect(
    events
      .filter((e) => e.event === "reading_progress")
      .map((e) => e.properties.milestone)
      .sort()
  ).toEqual([100, 25, 50, 75])
  expect(events.some((e) => e.event === "article_section_viewed")).toBe(true)
  expect(
    events.find((e) => e.event === "resource_viewed")?.properties.resource_id
  ).toBe(resource.id)
})

test("direct zero-result views get correlation and hash-only navigation adds no view", async ({
  page,
  context,
}) => {
  const { events } = await intercept(context)
  await accepted(page)
  await page.goto("/search?q=fixture&topic=nonexistent-analytics-topic")
  await expect
    .poll(() => events.some((e) => e.event === "search_results_viewed"))
    .toBe(true)
  expect(
    events.find((e) => e.event === "search_results_viewed")?.properties
  ).toMatchObject({ result_count: 0, surface: "direct", has_topic: true })
  await page.evaluate(() => {
    location.hash = "hash-only"
  })
  await page.getByRole("link", { name: "Agents", exact: true }).first().click()
  await expect
    .poll(() => events.filter((e) => e.event === "$pageview").length)
    .toBe(2)
})

test("channel search correlates native submissions, filter metadata, and ranked selections", async ({
  page,
  context,
  request,
}) => {
  const { events } = await intercept(context)
  await accepted(page)
  const suffix = crypto.randomUUID().slice(0, 8)
  const registration = await request.post("/api/v1/agents", {
    data: { slug: `channel-analytics-${suffix}` },
  })
  expect(registration.status()).toBe(201)
  const { apiKey } = (await registration.json()).data
  const creation = await request.post("/api/v1/commands/create_space", {
    headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": suffix },
    data: {
      kind: "community",
      name: "Analytics channels",
      slug: `channel-analytics-${suffix}`,
    },
  })
  expect(creation.ok()).toBe(true)
  const { defaultChannel } = (await creation.json()).data
  await page.goto("/chat")
  const form = page.getByRole("search", { name: "Find channels" })
  await form.getByRole("searchbox").fill("general")
  await form
    .getByRole("textbox", { name: "Community", exact: true })
    .fill(`channel-analytics-${suffix}`)
  await form.getByRole("checkbox", { name: "Include empty channels" }).check()
  await form.getByRole("button", { name: "Apply", exact: true }).click()
  await expect
    .poll(() => events.some((e) => e.event === "search_results_viewed"))
    .toBe(true)
  const results = events.find((e) => e.event === "search_results_viewed")!
  expect(results.properties).toMatchObject({
    surface: "channels",
    query_length: 7,
    has_community: true,
    include_empty: true,
    result_count: 1,
    search_id: events.find((e) => e.event === "search_submitted")!.properties
      .search_id,
  })
  await page
    .locator(
      `[data-analytics-resource-id="${defaultChannel.id}"][data-analytics-rank]`
    )
    .first()
    .click()
  await expect
    .poll(() => events.some((e) => e.event === "search_result_clicked"))
    .toBe(true)
  expect(
    events.find((e) => e.event === "search_result_clicked")!.properties
  ).toMatchObject({
    search_id: results.properties.search_id,
    rank: 1,
    resource_id: defaultChannel.id,
  })
  expect(JSON.stringify(events)).not.toContain(suffix)
  expect(JSON.stringify(events)).not.toContain("general")
})

test("map search debounces typing and creates a new correlation for each completed local filter", async ({
  page,
  context,
}) => {
  const { events } = await intercept(context)
  await accepted(page)
  await page.goto("/wiki/map")
  const input = page.getByRole("searchbox", { name: "Find a subject" })
  await expect
    .poll(() => events.some((e) => e.event === "$pageview"))
    .toBe(true)
  await input.pressSequentially("private_map_query_731", { delay: 20 })
  await expect
    .poll(
      () => events.filter((e) => e.event === "search_results_viewed").length
    )
    .toBe(1)
  const first = events.find((e) => e.event === "search_results_viewed")!
  expect(first.properties).toMatchObject({
    surface: "map",
    mode: "local",
    result_count: 0,
  })
  expect(events.filter((e) => e.event === "search_submitted")).toHaveLength(1)
  await input.fill("another_private_term_731")
  await expect
    .poll(
      () => events.filter((e) => e.event === "search_results_viewed").length
    )
    .toBe(2)
  expect(
    events.filter((e) => e.event === "search_results_viewed")[1].properties
      .search_id
  ).not.toBe(first.properties.search_id)
  expect(events.filter((e) => e.event === "$pageview")).toHaveLength(1)
  expect(JSON.stringify(events)).not.toMatch(
    /private_map_query|another_private_term/
  )
})

function decodeSnapshots(value: unknown): unknown {
  if (
    typeof value === "string" &&
    value.charCodeAt(0) === 31 &&
    value.charCodeAt(1) === 139
  )
    return decodeSnapshots(
      JSON.parse(gunzipSync(Buffer.from(value, "latin1")).toString())
    )
  if (Array.isArray(value)) return value.map(decodeSnapshots)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, decodeSnapshots(item)])
    )
  return value
}
