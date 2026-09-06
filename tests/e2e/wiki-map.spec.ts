import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("wiki evidence, missing-subject handoff, and interactive map work together", async ({
  page,
  request,
}) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
  const suffix = crypto.randomUUID().slice(0, 8)
  const registration = await request.post("/api/v1/agents", {
    data: { name: "Wiki map test", slug: `map-${suffix}` },
  })
  expect(registration.ok()).toBe(true)
  const { apiKey } = (await registration.json()).data
  const slug = `map-article-${suffix}`,
    missing = `missing-${suffix}`
  const title = `Map subject ${suffix}`,
    gapTitle = `Missing subject ${suffix}`
  const evidence = "https://www.w3.org/TR/prov-overview/"
  const image = "https://images.example.org/wiki-test.png"
  const save = await request.post("/api/v1/commands/publish", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": `map-${suffix}`,
    },
    data: {
      kind: "wiki",
      slug,
      title,
      topic: `topic-${suffix}`,
      body: `An evidence-backed claim. [Evidence](${evidence})\n\n![Test photograph](${image} "Test credit")\n\n## Related subjects\n\n[${gapTitle}](/wiki/${missing})`,
      citations: [{ url: evidence, title: "W3C provenance overview" }],
    },
  })
  expect(save.ok()).toBe(true)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.route(image, (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=",
        "base64"
      ),
    })
  )
  await page.goto(`/wiki/${slug}`)
  await expect(page.getByRole("img", { name: "Test photograph" })).toBeVisible()
  await page
    .getByRole("link", {
      name: "Source 1: W3C provenance overview",
      exact: true,
    })
    .click()
  await expect(page).toHaveURL(/#source-1$/)
  await expect(page.locator("#source-1")).toBeVisible()
  await page.getByRole("link", { name: "Return to citation 1" }).click()
  await expect(page).toHaveURL(/#cite-1-1$/)
  await page.getByRole("link", { name: gapTitle, exact: true }).click()
  await expect(page.getByRole("heading", { name: gapTitle })).toBeVisible()
  await expect(
    page.getByRole("link", { name: "View work request" })
  ).toBeVisible()
  await page.goto(`/wiki/map?focus=${slug}`)
  await expect(
    page.getByRole("heading", { name: "Knowledge map", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: new RegExp(`^${title},`) }).click()
  await expect(
    page
      .getByRole("complementary", { name: "Subject inspector" })
      .getByRole("heading", { name: title })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "Recent activity" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Zoom in", exact: true }).click()
  await expect(page.getByText("125%", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Fit map", exact: true }).click()
  await expect(page.getByText("100%", { exact: true })).toBeVisible()
  await page
    .getByRole("searchbox", { name: "Find a subject" })
    .fill("no-match-at-all")
  await expect(
    page.getByRole("heading", { name: "No matching subjects" })
  ).toBeVisible()
  await page.getByRole("button", { name: "Clear filters" }).click()
  await page
    .getByRole("button", { name: `${gapTitle}, missing article`, exact: true })
    .click()
  await expect(
    page.getByRole("link", { name: "View work request" })
  ).toBeVisible()
  await page
    .getByRole("checkbox", { name: "Knowledge gaps", exact: true })
    .uncheck()
  await expect(
    page.getByRole("button", {
      name: `${gapTitle}, missing article`,
      exact: true,
    })
  ).toHaveCount(0)
  const a11y = await new AxeBuilder({ page }).include("#page-content").analyze()
  expect(a11y.violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole("heading", { name: "Knowledge map", exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})
