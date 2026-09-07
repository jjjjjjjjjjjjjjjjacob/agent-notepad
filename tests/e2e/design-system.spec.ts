import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test.beforeEach(async ({ request }) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
})

const destinations = [
  ["/wiki", "Wiki", "All articles"],
  ["/wiki/map", "Wiki", "Knowledge map"],
  ["/changes", "Wiki", "Recent changes"],
  ["/tasks", "Wiki", "Tasks"],
  ["/communities", "Communities", "All communities"],
  ["/chat", "Communities", "Chat"],
  ["/notebooks", "Explore", "Notebooks"],
  ["/agents", "Explore", "Agents"],
  ["/place", "Explore", "Pixels"],
  ["/for-agents", "Resources", "Agent guide"],
  ["/policies", "Resources", "Community policy"],
] as const

test("sidebar destinations share header typography, spacing and responsive insets", async ({
  page,
}) => {
  test.setTimeout(180000)
  await page.emulateMedia({ reducedMotion: "reduce" })
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 })
    for (const theme of ["light", "dark"]) {
      await page.goto("/")
      await page.getByRole("button", { name: "Account and appearance" }).click()
      await page
        .getByRole("menuitem", {
          name: theme === "light" ? "Light" : "Dark",
          exact: true,
        })
        .click()
      let reference: unknown
      for (const [route, category, title] of destinations) {
        await page.goto(route)
        const heading = page.locator(
          '[data-slot="page-heading"][data-variant="page"]'
        )
        await expect(heading).toBeVisible()
        await expect(heading.getByRole("heading", { level: 1 })).toHaveText(
          title
        )
        await expect(heading.locator('[data-slot="page-eyebrow"]')).toHaveText(
          category
        )
        await expect(page.locator("html")).toHaveClass(new RegExp(theme))
        await page.evaluate(() => document.fonts.ready)
        const appearance = await heading.evaluate((el) => {
          const title = el.querySelector("h1")!
          const eyebrow = el.querySelector('[data-slot="page-eyebrow"]')!
          const description = el.querySelector(
            '[data-slot="page-description"]'
          )!
          const read = (node: Element) => {
            const s = getComputedStyle(node)
            return [
              s.fontFamily,
              s.fontSize,
              s.fontWeight,
              s.lineHeight,
              s.letterSpacing,
              s.color,
            ]
          }
          return {
            title: read(title),
            eyebrow: read(eyebrow),
            description: read(description),
            x: Math.round(title.getBoundingClientRect().x),
            y: Math.round(eyebrow.getBoundingClientRect().y),
            gap: Math.round(
              description.getBoundingClientRect().top -
                title.getBoundingClientRect().bottom
            ),
          }
        })
        reference ??= appearance
        expect(appearance, `${route} at ${width}px in ${theme}`).toEqual(
          reference
        )
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth
          )
        ).toBe(true)
      }
    }
  }
})

test("new visitors default to light while explicit appearance choices and account controls work", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" })
  await page.goto("/")
  const account = page.getByRole("button", { name: "Account and appearance" })
  await expect(page.locator("html")).toHaveClass(/light/)
  await expect(account).toHaveCSS("width", "40px")
  await expect(account.locator("svg")).toHaveCSS("width", "20px")
  await expect(
    page
      .getByRole("banner")
      .getByRole("link", { name: "Connect agent" })
      .locator("svg")
  ).toHaveCSS("width", "16px")
  await account.focus()
  await page.keyboard.press("Enter")
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click()
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await account.click()
  await page.getByRole("menuitem", { name: "System", exact: true }).click()
  await page.emulateMedia({ colorScheme: "light" })
  await expect(page.locator("html")).toHaveClass(/light/)
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/light/)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(account).toHaveCSS("width", "44px")
  expect(
    (await new AxeBuilder({ page }).include("header").analyze()).violations
  ).toEqual([])
})

test("Style Lab updates variants, persists presets, resets and keeps fallback accessible", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" })
  await page.goto("/")
  const effect = page.locator('[data-slot="hero-particles"]')
  const title = page.getByRole("heading", { level: 1 })
  const initialBox = await title.boundingBox()
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  const panel = page.getByRole("complementary", {
    name: "Development styling panel",
  })
  for (const name of ["Appearance", "Liquid motion", "Mouse interaction"])
    await expect(panel.getByRole("group", { name, exact: true })).toBeVisible()
  await expect(
    panel.getByText("6,000 desktop · 1,500 mobile", { exact: true })
  ).toBeVisible()
  const originalRadius = await effect
    .locator("circle")
    .first()
    .getAttribute("r")
  await expect(effect.locator("circle")).toHaveCount(720)
  const select = panel.getByRole("combobox", { name: "Particle effect" })
  for (const [name, value] of [
    ["Wave field", "wave"],
    ["Orbital streams", "orbit"],
    ["Notebook assembly", "notebook"],
    ["Liquid currents", "constellation"],
  ]) {
    await select.click()
    await page.getByRole("option", { name, exact: true }).click()
    await expect(effect).toHaveAttribute("data-variant", value)
    await expect(effect).toHaveAttribute("data-render-state", "fallback")
    expect(await title.boundingBox()).toEqual(initialBox)
  }
  for (const [label, token, value] of [
    ["Particle density", "--hero-density", "1.1"],
    ["Animation speed", "--hero-speed", "0.7"],
    ["Drift", "--hero-wind", "1.1"],
    ["Liquid circulation", "--hero-convection", "1.1"],
    ["Viscosity", "--hero-viscosity", "0.75"],
    ["Particle field height", "--hero-reach", "920px"],
    ["Particle opacity", "--hero-opacity", "0.45"],
    ["Particle size", "--hero-size", "1.6px"],
    ["Pointer response", "--hero-pointer", "0.3"],
    ["Click scatter", "--hero-scatter", "0.85"],
    ["Size variation", "--hero-size-variation", "0.35"],
    ["Opacity variation", "--hero-opacity-variation", "0.7"],
    ["Particle softness", "--hero-softness", "0.75"],
    ["Center clarity", "--hero-center-fade", "0.95"],
    ["Current size", "--hero-current-size", "380px"],
    ["Fine eddies", "--hero-turbulence", "1.1"],
    ["Current evolution", "--hero-evolution", "1.1"],
    ["Pointer radius", "--hero-pointer-radius", "180px"],
    ["Pointer swirl", "--hero-pointer-swirl", "1.1"],
    ["Particle highlight", "--hero-highlight", "0.55"],
    ["Scatter radius", "--hero-scatter-radius", "260px"],
    ["Interaction settling", "--hero-settling", "1.7s"],
  ]) {
    const slider = panel.getByRole("slider", { name: label, exact: true })
    await slider.focus()
    await slider.press("ArrowRight")
    await expect(page.locator("html")).toHaveCSS(token, value)
  }
  await expect(effect.locator("circle")).toHaveCount(792)
  expect(await effect.locator("circle").first().getAttribute("r")).not.toBe(
    originalRadius
  )
  await expect(
    panel.getByText("6,600 desktop · 1,650 mobile", { exact: true })
  ).toBeVisible()
  await select.click()
  await page.getByRole("option", { name: "Off", exact: true }).click()
  await expect(effect).toHaveCount(0)
  await page.reload()
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await expect(effect).toHaveCount(0)
  await panel.locator('input[type="file"]').setInputFiles({
    name: "legacy.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        version: 1,
        values: { bodySize: 16, heroVariant: "orbit", heroOpacity: 0.7 },
      })
    ),
  })
  await expect(effect).toHaveAttribute("data-variant", "orbit")
  await expect(effect.locator("svg")).toHaveCSS("opacity", "0.7")
  const downloadPromise = page.waitForEvent("download")
  await panel.getByRole("button", { name: "Export JSON" }).click()
  const download = await downloadPromise
  const stream = await download.createReadStream()
  const chunks: Buffer[] = []
  for await (const chunk of stream!) chunks.push(chunk)
  expect(JSON.parse(Buffer.concat(chunks).toString()).values).toMatchObject({
    heroVariant: "orbit",
    heroOpacity: 0.7,
  })
  await page.getByText("Hero animation", { exact: true }).click()
  await panel
    .getByRole("button", { name: "Reset Hero animation", exact: true })
    .click()
  await expect(effect).toHaveAttribute("data-variant", "constellation")
  await expect(effect.locator("svg")).toHaveCSS("opacity", "0.4")
  await panel.getByRole("button", { name: "Reset all" }).click()
  await panel.getByRole("button", { name: "Close style lab" }).click()
  await expect(page.getByRole("button", { name: "Copy prompt" })).toBeVisible()
  expect(
    (await new AxeBuilder({ page }).include("#page-content").analyze())
      .violations
  ).toEqual([])
})

test("missing WebGPU leaves a static decoration and functional server-rendered content", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(navigator, "gpu", {
      value: undefined,
      configurable: true,
    })
  )
  await page.goto("/")
  await expect(page.locator('[data-slot="hero-particles"]')).toHaveAttribute(
    "data-render-state",
    "fallback"
  )
  await expect(page.locator('[data-slot="hero-canvas"]')).toHaveCount(0)
  await expect(
    page.getByRole("link", { name: "Explore the wiki", exact: true })
  ).toHaveAttribute("href", "/wiki")
})

test("GPU initialization failure falls back without disrupting the homepage", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "gpu", {
      value: {
        requestAdapter: async () => {
          throw new Error("Test adapter unavailable")
        },
      },
      configurable: true,
    })
  })
  await page.goto("/")
  const effect = page.locator('[data-slot="hero-particles"]')
  await expect(effect).toHaveAttribute("data-render-state", "fallback")
  await expect(effect.locator("svg")).toBeVisible()
  await expect(page.getByRole("button", { name: "Copy prompt" })).toBeVisible()
  expect(errors).toEqual([])
})
