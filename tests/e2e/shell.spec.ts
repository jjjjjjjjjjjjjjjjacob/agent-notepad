import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("desktop sidebar collapses smoothly to usable icons and preserves mobile navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto("/wiki")
  const toggle = page.locator('[data-slot="sidebar-trigger"]')
  const sidebar = page.locator('[data-slot="sidebar-container"]')
  const panel = page.locator('[data-slot="sidebar-inset"]')
  const search = page.getByRole("search", { name: "Search Agent Notepad" })
  const nav = page.getByRole("navigation", { name: "Primary navigation" })
  const wordmark = page
    .getByRole("banner")
    .getByRole("link", { name: "Agent Notepad" })
  await expect(toggle).toHaveAttribute("aria-expanded", "true")
  await expect(wordmark.locator("svg")).toHaveCount(0)
  const expandedWidth = (await sidebar.boundingBox())!.width

  // Sample the real layout through the transition: header, rail and panel
  // should share a moving edge, including the intermediate animation frames.
  const frames = await page.evaluate(async () => {
    const toggle = document.querySelector<HTMLButtonElement>(
      '[data-slot="sidebar-trigger"]'
    )!
    const sidebar = document.querySelector('[data-slot="sidebar-container"]')!
    const panel = document.querySelector('[data-slot="sidebar-inset"]')!
    const search = document.querySelector(
      'form[aria-label="Search Agent Notepad"]'
    )!
    const frames: { width: number; panelX: number; searchX: number }[] = []
    toggle.click()
    const start = performance.now()
    while (performance.now() - start < 400) {
      await new Promise(requestAnimationFrame)
      frames.push({
        width: sidebar.getBoundingClientRect().width,
        panelX: panel.getBoundingClientRect().x,
        searchX: search.getBoundingClientRect().x,
      })
    }
    return frames
  })
  expect(
    frames.some(({ width }) => width > 61 && width < expandedWidth - 1)
  ).toBe(true)
  for (const frame of frames) {
    expect(Math.abs(frame.width - frame.panelX)).toBeLessThan(1)
    expect(Math.abs(frame.width - frame.searchX)).toBeLessThan(1)
  }
  await expect(sidebar).toHaveCSS("width", "60px")
  await expect(toggle).toHaveAccessibleName("Expand sidebar")
  await expect(toggle).toHaveAttribute("aria-expanded", "false")
  await expect(wordmark).toBeHidden()
  const articles = nav.getByRole("link", { name: "All articles", exact: true })
  await expect(articles).toHaveAttribute("aria-current", "page")
  await articles.hover()
  await expect(
    page.locator('[data-slot="tooltip-content"][data-open]')
  ).toHaveText("All articles")
  await page.mouse.move(600, 100)
  const guide = page
    .getByRole("navigation", { name: "Resources" })
    .getByRole("link", { name: "Agent guide" })
  await guide.focus()
  await expect(
    page.locator('[data-slot="tooltip-content"][data-open]')
  ).toHaveText("Agent guide")
  await nav.getByRole("link", { name: "Notebooks", exact: true }).click()
  await expect(page).toHaveURL(/\/notebooks$/)
  await expect(sidebar).toHaveCSS("width", "60px")
  expect(
    (
      await new AxeBuilder({ page })
        .include("header")
        .include('[data-slot="sidebar-container"]')
        .analyze()
    ).violations
  ).toEqual([])

  // Even in a short desktop window every icon remains reachable by scrolling.
  await page.setViewportSize({ width: 768, height: 480 })
  const agents = nav.getByRole("link", { name: "Agents", exact: true })
  await agents.focus()
  await expect(agents).toBeInViewport()
  await page.keyboard.press("Control+b")
  await expect(sidebar).toHaveCSS("width", `${expandedWidth}px`)
  await expect(wordmark).toBeVisible()
  await toggle.click()
  await expect(sidebar).toHaveCSS("width", "60px")

  await page.setViewportSize({ width: 390, height: 844 })
  await expect(wordmark).toBeVisible()
  await toggle.click()
  const drawer = page.getByRole("dialog", { name: "Sidebar", exact: true })
  await expect(
    drawer
      .getByRole("link", { name: "All articles", exact: true })
      .locator("span")
  ).toBeVisible()
  await drawer.getByRole("link", { name: "All articles", exact: true }).click()
  await expect(drawer).toBeHidden()
  await expect(page).toHaveURL(/\/wiki$/)
  await page.setViewportSize({ width: 1440, height: 900 })
  await expect(sidebar).toHaveCSS("width", "60px")
  expect((await search.boundingBox())!.x).toBe((await panel.boundingBox())!.x)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await toggle.click()
  await expect(sidebar).toHaveCSS("transition-duration", "0s")
  await expect(sidebar).toHaveCSS("width", `${expandedWidth}px`)
})

test("command search has one focus ring around the icon and input in both themes", async ({
  page,
}) => {
  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme })
    await page.goto("/wiki")
    await page.getByRole("button", { name: "Account and appearance" }).click()
    await page.getByRole("menuitem", { name: colorScheme === "light" ? "Light" : "Dark", exact: true }).click()
    await page.getByRole("button", { name: "Search and navigate" }).click()
    const dialog = page.getByRole("dialog", { name: "Search Agent Notepad" })
    const input = dialog.getByRole("combobox")
    const field = dialog.locator('[data-slot="input-group"]')
    await expect(input).toBeFocused()
    await expect(field).toHaveCSS("outline-style", "solid")
    await expect(field).toHaveCSS("outline-width", "2px")
    await expect(input).toHaveCSS("outline-style", "none")
    // Measure in one frame while the dialog's entrance animation is active.
    const [fieldBox, iconBox, inputBox] = await field.evaluate((node) =>
      [node, node.querySelector("svg")!, node.querySelector("input")!].map((element) => {
        const { x, width } = element.getBoundingClientRect()
        return { x, width }
      })
    )
    expect(iconBox.x).toBeGreaterThan(fieldBox.x)
    expect(inputBox.x + inputBox.width).toBeLessThanOrEqual(
      fieldBox.x + fieldBox.width
    )
    await field.locator("svg").click()
    await expect(input).toBeFocused()
    expect(
      (
        await new AxeBuilder({ page })
          .include('[data-slot="dialog-content"]')
          .analyze()
      ).violations
    ).toEqual([])
    await page.keyboard.press("ArrowDown")
    await page.keyboard.press("Escape")
    await expect(dialog).toBeHidden()
    await expect(
      page.getByRole("button", { name: "Search and navigate" })
    ).toBeFocused()
    await page.keyboard.press("Control+k")
    await expect(input).toBeFocused()
    await input.fill("provenance")
    await input.press("Enter")
    await expect(page).toHaveURL(/\/search\?q=provenance$/)
  }
})
