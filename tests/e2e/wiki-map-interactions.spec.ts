import { test, expect, type Locator } from "@playwright/test"

async function center(node: Locator) {
  return node.evaluate((element) => {
    const matrix = (element as SVGGraphicsElement).getScreenCTM()!
    return { x: matrix.e, y: matrix.f }
  })
}
async function position(node: Locator) {
  return node.evaluate((element) => {
    const matrix = (
      element as SVGGraphicsElement
    ).transform.baseVal.consolidate()!.matrix
    return { x: matrix.e, y: matrix.f }
  })
}

test("a dense map prioritizes hubs, expands on hover, and supports movement in both dimensions", async ({
  page,
  request,
}) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
  const suffix = crypto.randomUUID().slice(0, 8)
  const slug = `motion-hub-${suffix}`
  const registration = await request.post("/api/v1/agents", {
    data: { name: "Map motion test", slug: `motion-${suffix}` },
  })
  expect(registration.ok()).toBe(true)
  const { apiKey } = (await registration.json()).data
  const save = await request.post("/api/v1/commands/publish", {
    headers: { Authorization: `Bearer ${apiKey}`, "Idempotency-Key": slug },
    data: {
      kind: "wiki",
      slug,
      title: "Connected hub",
      topic: `motion-${suffix}`,
      body: Array.from(
        { length: 60 },
        (_, i) => `[Subject ${i}](/wiki/motion-${suffix}-${i})`
      ).join("\n\n"),
    },
  })
  expect(save.ok()).toBe(true)
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat/i.test(message.text()))
      errors.push(message.text())
  })
  await page.setViewportSize({ width: 1600, height: 1100 })
  await page.goto(`/wiki/map?focus=${slug}`)
  const graph = page.locator("svg[data-view]")
  const hub = graph.locator(`[data-node="${slug}"]`)
  const leaf = graph.locator(`[data-node="motion-${suffix}-0"]`)
  await expect(graph.locator("[data-node]")).toHaveCount(61)
  await expect(graph.locator('[data-label-visible="true"]')).toHaveCount(1)
  const beforeMotion = await position(hub)
  await expect
    .poll(async () => Math.abs((await position(hub)).x - beforeMotion.x))
    .toBeGreaterThan(0.5)
  await page.getByRole("button", { name: "Pause map motion" }).click()
  await expect(graph).toHaveAttribute("data-motion", "paused")
  // Allow the existing easing to settle before measuring hover and drag deltas.
  await page.waitForTimeout(800)
  const still = await position(hub)
  await page.waitForTimeout(250)
  expect(Math.abs((await position(hub)).x - still.x)).toBeLessThan(0.1)
  const beforeLeaf = await position(leaf)
  const hubCenter = await center(hub)
  await page.mouse.move(hubCenter.x, hubCenter.y)
  await expect(hub).toHaveAttribute("data-expanded", "true")
  await expect
    .poll(async () =>
      Math.hypot(
        (await position(leaf)).x - beforeLeaf.x,
        (await position(leaf)).y - beforeLeaf.y
      )
    )
    .toBeGreaterThan(20)
  await page.waitForTimeout(500)
  const pinned = await center(hub)
  expect(
    Math.hypot(pinned.x - hubCenter.x, pinned.y - hubCenter.y)
  ).toBeLessThan(1)
  await expect(graph.locator('line[data-highlighted="true"]')).toHaveCount(60)
  const edge = graph.locator(`line[data-target="motion-${suffix}-0"]`)
  const leafPoint = await position(leaf)
  expect(Number(await edge.getAttribute("x2"))).toBeCloseTo(leafPoint.x, 0)
  expect(Number(await edge.getAttribute("y2"))).toBeCloseTo(leafPoint.y, 0)

  // A low-degree subject reveals its label and remains anchored under the pointer.
  const leafCenter = await center(leaf)
  await page.mouse.move(leafCenter.x, leafCenter.y)
  await expect(leaf).toHaveAttribute("data-expanded", "true")
  await expect(leaf.locator("text")).toBeVisible()
  await page.waitForTimeout(450)
  await expect(leaf).toHaveAttribute("data-expanded", "true")
  const leafPinned = await center(leaf)
  expect(
    Math.hypot(leafPinned.x - leafCenter.x, leafPinned.y - leafCenter.y)
  ).toBeLessThan(1)

  // Dragging a subject must not accidentally change the inspector selection.
  await page.mouse.down()
  await page.mouse.move(leafCenter.x + 45, leafCenter.y + 25, { steps: 5 })
  await page.mouse.up()
  await expect(hub).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(async () => center(leaf).then((p) => p.x - leafCenter.x))
    .toBeGreaterThan(35)
  await page.mouse.move(10, 10)
  await page.waitForTimeout(600)
  const dropped = await center(leaf)
  expect(dropped.x - leafCenter.x).toBeCloseTo(45, 0)
  expect(dropped.y - leafCenter.y).toBeCloseTo(25, 0)

  await page.getByRole("button", { name: "3D view", exact: true }).click()
  await expect(graph).toHaveAttribute("data-view", "3d")
  await expect(
    page.getByRole("button", { name: "3D view", exact: true })
  ).toHaveAttribute("aria-pressed", "true")
  await expect
    .poll(async () => Math.abs(Number(await leaf.getAttribute("data-depth"))))
    .toBeGreaterThan(1)
  await graph.focus()
  const beforeOrbit = await position(leaf)
  await graph.press("ArrowRight")
  await expect
    .poll(async () => Math.abs((await position(leaf)).x - beforeOrbit.x))
    .toBeGreaterThan(5)
  const beforePan = await graph
    .locator("[data-camera]")
    .getAttribute("transform")
  await graph.press("Shift+ArrowRight")
  await expect(graph.locator("[data-camera]")).not.toHaveAttribute(
    "transform",
    beforePan!
  )
  await page.getByRole("button", { name: "2D view", exact: true }).click()
  await page.getByRole("button", { name: "Fit map", exact: true }).click()
  await expect(graph).toHaveAttribute("data-view", "2d")

  // Keyboard focus offers the same lens and label as hover.
  await page.mouse.move(10, 10)
  await graph.focus()
  await graph.press("Tab")
  await expect(graph.locator('[data-expanded="true"]')).toHaveCount(1)

  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(
    page.getByRole("button", { name: "Resume map motion" })
  ).toBeDisabled()
  await expect(graph).toHaveAttribute("data-motion", "paused")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(
    page.getByRole("button", { name: "3D view", exact: true })
  ).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  expect(errors).toEqual([])
})
