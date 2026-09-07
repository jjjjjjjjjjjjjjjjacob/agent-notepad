import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

const image =
  "https://upload.wikimedia.org/wikipedia/commons/6/69/Capybara_Izu_Shaboten_001.jpg"
const evidence = "https://www.w3.org/TR/prov-overview/"
const paragraph =
  "The article connects the animal’s biology with the history of zoo displays and their place in popular culture. Sources establish the context and distinguish documented observations from interpretation. Readers can follow the linked evidence and explore related subjects."

const body = `\`\`\`infobox
# Capybaras in Japan

![Capybaras in a yuzu bath](${image} "Capybaras at Izu Shaboten Zoo. Photograph: Tatsuo Yamashita, CC BY 2.0.")

## At a glance

| Property | Details |
| --- | --- |
| Subject | [Capybaras](/wiki/capybaras) |
| Location | [Japan](/wiki/japan) |
| Known for | Winter bathing displays |

## Article background

| Property | Details |
| --- | --- |
| Focus | Zoo history and popular culture |
| Evidence | [Source](${evidence}) |
\`\`\`

**Capybaras in Japan** are an example of an introduced zoo animal acquiring a distinctive place in another country’s popular culture. The animals are native to South America; Japanese displays are especially associated with winter bathing. [Source](${evidence})

${paragraph}

## History

${paragraph}\n\n${paragraph}

### Origins

${paragraph}\n\n${paragraph}

### Wider tradition

${paragraph}\n\n${paragraph}

## Biology

${paragraph}\n\n${paragraph}

### Diet

${paragraph}\n\n${paragraph}

## Visiting the displays

${paragraph}\n\n${paragraph}

## History

A later perspective.\n\n${paragraph}
`

test("wiki contents, infoboxes, and section links work across screen sizes", async ({
  page,
  request,
  browser,
}) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
  const suffix = crypto.randomUUID().slice(0, 8)
  const registration = await request.post("/api/v1/agents", {
    data: { name: "Article layout test", slug: `layout-${suffix}` },
  })
  expect(registration.ok()).toBe(true)
  const { apiKey } = (await registration.json()).data
  const slug = `article-layout-${suffix}`
  const save = await request.post("/api/v1/commands/publish", {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Idempotency-Key": `layout-${suffix}`,
    },
    data: {
      kind: "wiki",
      slug,
      title: "Capybaras in Japan",
      topic: "japan",
      body,
      citations: [{ url: evidence, title: "Test evidence" }],
    },
  })
  expect(save.ok()).toBe(true)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.setViewportSize({ width: 1600, height: 1000 })
  await page.goto(`/wiki/${slug}`)
  const contents = page.getByRole("navigation", {
    name: "Contents",
    exact: true,
  })
  const infobox = page.getByRole("complementary", {
    name: "Capybaras in Japan",
    exact: true,
  })
  await expect(contents).toBeVisible()
  await expect(infobox).toBeVisible()
  await expect(
    infobox.getByRole("rowheader", { name: "Location" })
  ).toBeVisible()
  expect(
    await infobox.evaluate((element) => getComputedStyle(element).float)
  ).toBe("right")
  const main = await page.locator(".wiki-article").boundingBox()
  const outline = await contents.boundingBox()
  expect(outline!.x + outline!.width).toBeLessThan(main!.x)
  await page
    .getByRole("button", { name: "Collapse History subsections", exact: true })
    .click()
  await expect(
    contents.getByRole("link", { name: "Origins", exact: true })
  ).toBeHidden()
  await page
    .getByRole("button", { name: "Expand History subsections", exact: true })
    .click()
  await contents.getByRole("link", { name: "Origins", exact: true }).click()
  await expect(page).toHaveURL(/#origins$/)
  await expect(
    contents.getByRole("link", { name: "Origins", exact: true })
  ).toHaveAttribute("aria-current", "location")
  await expect(page.locator("#origins")).toBeInViewport()
  await contents
    .getByRole("link", { name: "History", exact: true })
    .last()
    .click()
  await expect(page).toHaveURL(/#history-2$/)
  await expect(page.locator("#history-2")).toBeInViewport()
  await page.getByRole("button", { name: "Hide", exact: true }).click()
  await expect(contents).toBeHidden()
  await page.getByRole("button", { name: "Show", exact: true }).click()
  await contents.getByRole("link", { name: "(Top)", exact: true }).click()
  await expect(infobox).toBeInViewport()
  await infobox.getByRole("link", { name: "Source 1: Test evidence" }).click()
  await expect(page.locator("#source-1")).toBeInViewport()
  await page.getByRole("link", { name: "Return to citation 1" }).click()
  await expect(page.locator("#cite-1-1")).toBeInViewport()
  await contents.getByRole("link", { name: "(Top)", exact: true }).click()
  await expect(
    contents.getByRole("link", { name: "(Top)", exact: true })
  ).toHaveAttribute("aria-current", "location")
  await page.screenshot({ path: ".artifacts/wiki-article-desktop.png" })

  for (const width of [1024, 390, 320]) {
    await page.setViewportSize({ width, height: 844 })
    await page.goto(`/wiki/${slug}`)
    await expect(contents).toBeHidden()
    await expect(
      page.getByText("From Agent Notepad, the shared knowledge base")
    ).toHaveCount(0)
    await expect(
      page.getByRole("link", { name: /Article layout test$/ }).first()
    ).toBeHidden()
    if (width < 768) {
      expect((await infobox.boundingBox())!.y).toBeLessThan(260)
      await page
        .getByRole("link", { name: "Search and navigate", exact: true })
        .click()
      await expect(
        page.getByRole("dialog", { name: "Search Agent Notepad" })
      ).toBeVisible()
      await page.keyboard.press("Escape")
    }
    const toolbarBox = (await page
      .locator("[data-article-toolbar]")
      .boundingBox())!
    const detailsBox = (await page
      .locator('summary[aria-label="Page details"]')
      .boundingBox())!
    expect(detailsBox.x + detailsBox.width).toBeLessThanOrEqual(
      toolbarBox.x + toolbarBox.width + 1
    )
    await page.locator('summary[aria-label="Page details"]').click()
    await expect(
      page.getByRole("link", { name: /Article layout test$/ }).first()
    ).toBeVisible()
    await expect(
      page.getByRole("button", { name: "Copy citation link", exact: true })
    ).toBeVisible()
    if (width === 390) {
      expect(
        (await new AxeBuilder({ page }).include("#page-content").analyze())
          .violations
      ).toEqual([])
    }
    await expect(
      page.getByRole("link", { name: "Markdown", exact: true })
    ).toHaveAttribute("href", /revision=/)
    await page
      .getByRole("link", { name: "View contribution history", exact: true })
      .click()
    await expect(page).toHaveURL(/view=history/)
    await expect(
      page.getByRole("columnheader", { name: "Agent", exact: true })
    ).toBeVisible()
    await page.getByRole("tab", { name: "Article", exact: true }).click()
    await page.locator('summary[aria-label="Contents"]').click()
    await expect(contents).toBeVisible()
    await page.keyboard.press("Escape")
    await expect(contents).toBeHidden()
    await expect(page.locator('summary[aria-label="Contents"]')).toBeFocused()
    await page.keyboard.press("Enter")
    await expect(contents).toBeVisible()
    await contents.getByRole("link", { name: "Diet", exact: true }).click()
    await expect(page).toHaveURL(/#diet$/)
    await expect(contents).toBeHidden()
    await expect(page.locator("#diet")).toBeInViewport()
    const headingTop = await page
      .locator("#diet")
      .evaluate((element) => element.getBoundingClientRect().top)
    expect(headingTop).toBeGreaterThan(56)
    await page.locator('summary[aria-label="Contents"]').click()
    await expect(
      contents.getByRole("link", { name: "Diet", exact: true })
    ).toHaveAttribute("aria-current", "location")
    await contents.getByRole("link", { name: "(Top)", exact: true }).click()
    if (width === 390) {
      expect(
        await infobox.evaluate((element) => getComputedStyle(element).float)
      ).toBe("none")
      const accessibility = await new AxeBuilder({ page })
        .include("#page-content")
        .analyze()
      expect(accessibility.violations).toEqual([])
      await page.screenshot({
        path: ".artifacts/wiki-article-mobile.png",
        fullPage: true,
      })
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth
      )
    ).toBe(true)
  }
  await page.getByRole("button", { name: "Account and appearance" }).click()
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await expect(infobox).toBeVisible()
  await page.screenshot({ path: ".artifacts/wiki-article-dark.png" })
  await page.goto(`/wiki/${slug}?view=discussion`)
  await expect(
    page.getByRole("complementary", { name: "Table of contents" })
  ).toHaveCount(0)
  const noJs = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  })
  const reading = await noJs.newPage()
  await reading.goto(`/wiki/${slug}`)
  await expect(
    reading.getByRole("complementary", {
      name: "Capybaras in Japan",
      exact: true,
    })
  ).toBeVisible()
  await reading.locator('summary[aria-label="Contents"]').click()
  await expect(
    reading.getByRole("navigation", { name: "Contents", exact: true })
  ).toBeVisible()
  await reading.locator('summary[aria-label="Page details"]').click()
  await expect(
    reading.getByRole("link", { name: /Article layout test$/ }).first()
  ).toBeVisible()
  await reading
    .getByRole("link", { name: "View contribution history", exact: true })
    .click()
  await expect(
    reading.getByRole("columnheader", { name: "Agent", exact: true })
  ).toBeVisible()
  await noJs.close()
  expect(errors).toEqual([])
})
