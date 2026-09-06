import { test, expect } from "@playwright/test"

test.skip(
  (process.env.PLACE_ENABLED ?? "true") !== "true",
  "Place is disabled for this test deployment."
)

test("canvas renders full geometry, inspects coordinates and reconnects bounded live tiles", async ({
  page,
}) => {
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.goto("/place")
  await expect(page.getByRole("heading", { name: "Pixels" })).toBeVisible()
  const canvas = page.getByLabel("Live 1000 by 1000 pixel canvas", {
    exact: false,
  })
  await expect(canvas).toBeVisible()
  await expect(page.getByText("Loading pixel…")).toHaveCount(0)
  await expect(page.getByText("Loading live colors…")).toHaveCount(0)
  expect(await page.locator("canvas").count()).toBe(1)
  expect(await page.locator("*").count()).toBeLessThan(2500)
  await page.getByLabel("X coordinate", { exact: true }).fill("999")
  await page.getByLabel("Y coordinate", { exact: true }).fill("999")
  await page.getByRole("button", { name: "Go", exact: true }).click()
  await expect(page.getByText("999, 999", { exact: true })).toBeVisible()
  await canvas.focus()
  await page.keyboard.press("ArrowLeft")
  await expect(page.getByText("998, 999", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Fit canvas" }).click()
  await page.context().setOffline(true)
  await page.context().setOffline(false)
  await page.getByLabel("X coordinate", { exact: true }).fill("0")
  await page.getByLabel("Y coordinate", { exact: true }).fill("0")
  await page.getByRole("button", { name: "Go", exact: true }).click()
  await expect(page.getByText("0, 0", { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Fit canvas" }).click()
  await page.screenshot({
    path: ".artifacts/place-desktop.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(canvas).toBeVisible()
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({ path: ".artifacts/place-mobile.png", fullPage: true })
  expect(errors).toEqual([])
})

test("wallet labels all funds as simulated and requires a human account", async ({
  page,
}) => {
  await page.goto("/account/place")
  await expect(
    page.getByRole("heading", { name: "Sandbox wallet" })
  ).toBeVisible()
  await expect(
    page.getByText("Real funding, custody, and payouts are disabled.", {
      exact: false,
    })
  ).toBeVisible()
  await expect(
    page.getByRole("link", { name: "Sign in or create an account" })
  ).toBeVisible()
})

test("a human funds an agent that acquires and paints a pixel through REST", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8),
    name = `Place browser ${suffix}`
  const registration = await request.post("/api/v1/agents", {
    data: { name, slug: `place-browser-${suffix}` },
  })
  expect(registration.status()).toBe(201)
  const agent = (await registration.json()).data
  await page.goto("/account")
  await page.getByRole("tab", { name: "Create account", exact: true }).click()
  await page.getByLabel("Account name").fill("Canvas test human")
  await page
    .getByLabel("Email", { exact: true })
    .fill(`place-${suffix}@example.invalid`)
  await page
    .getByLabel("Password", { exact: true })
    .fill(`isolated-test-${crypto.randomUUID()}`)
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(
    page.getByText(`Signed in as place-${suffix}@example.invalid`)
  ).toBeVisible()
  const linking = await request.post("/api/v1/agents/link", {
    headers: { Authorization: `Bearer ${agent.apiKey}` },
    data: {},
  })
  const { linkingCode } = (await linking.json()).data
  await page.getByLabel("Linking code", { exact: true }).fill(linkingCode)
  await page.getByRole("button", { name: "Link agent", exact: true }).click()
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible()
  await page.goto("/account/place")
  await page.getByRole("button", { name: "Confirm simulated funding" }).click()
  await expect(
    page.getByText("$100.00", { exact: false }).first()
  ).toBeVisible()
  await page.getByRole("button", { name: "Move sandbox funds" }).click()
  await expect(
    page
      .getByRole("row")
      .filter({ has: page.getByRole("link", { name, exact: true }) })
  ).toContainText("$10.00")
  async function command(operation: string, input: unknown) {
    const response = await request.post(`/api/v1/commands/${operation}`, {
      headers: {
        Authorization: `Bearer ${agent.apiKey}`,
        "Idempotency-Key": crypto.randomUUID(),
      },
      data: input,
    })
    expect(response.ok(), await response.text()).toBe(true)
    return (await response.json()).data
  }
  // Native load fixtures use scattered coordinates; choose and verify a free pixel here.
  let pixel = 0
  for (let i = 0; i < 50; i++) {
    pixel = Math.floor(Math.random() * 1000000)
    const read = await request.get(`/api/v1/place_pixel?pixel=${pixel}`)
    if ((await read.json()).data.custody === "unowned") break
  }
  const draft = await command("place_create", {
    kind: "initial",
    title: name,
    pixelCount: 1,
  })
  await command("place_append", { dealId: draft.dealId, pixels: [pixel] })
  await command("place_seal", { dealId: draft.dealId })
  await expect
    .poll(async () => {
      const response = await request.get(
        `/api/v1/place_deal?id=${draft.dealId}`
      )
      return (await response.json()).data.status
    })
    .toBe("committed")
  await command("place_paint", { pixels: [{ pixel, color: 5 }] })
  const tile =
    Math.floor(Math.floor(pixel / 1000) / 50) * 20 +
    Math.floor((pixel % 1000) / 50)
  const tileResponse = await request.get(`/api/v1/place_tiles?tiles=${tile}`)
  const tileColors = (await tileResponse.json()).data[0].colors
  expect(tileColors).toHaveLength(2500)
  expect(tileColors[(Math.floor(pixel / 1000) % 50) * 50 + (pixel % 50)]).toBe(
    5
  )
  await page.goto("/place")
  await page
    .getByLabel("X coordinate", { exact: true })
    .fill(String(pixel % 1000))
  await page
    .getByLabel("Y coordinate", { exact: true })
    .fill(String(Math.floor(pixel / 1000)))
  await page.getByRole("button", { name: "Go", exact: true }).click()
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible()
  await expect(page.getByText("Red", { exact: true })).toBeVisible()
})
