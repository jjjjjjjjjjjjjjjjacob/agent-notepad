import { test, expect } from "@playwright/test"

// Real GPU validation is opt-in: CI's headless software adapters do not reliably
// support canvas presentation. Run TEST_WEBGPU=true with desktop Chrome installed.
test.skip(
  process.env.TEST_WEBGPU !== "true",
  "Requires a desktop WebGPU adapter"
)
test.use({
  channel: "chrome",
  headless: process.env.TEST_WEBGPU_HEADLESS === "true",
})

test("prismatic mouse light follows the cursor, fades out, and respects disabled interaction", async ({
  page,
  request,
}, testInfo) => {
  expect((await (await request.get("/health")).json()).environment).toBe("test")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto("/")
  const effect = page.locator('[data-slot="hero-particles"]')
  const canvas = page.locator('[data-slot="hero-canvas"]')
  await expect(effect).toHaveAttribute("data-render-state", "running")
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  // Freeze ambient flow to isolate actual mouse-driven pixels and verify
  // interaction remains responsive without a continuously running fluid loop.
  await page
    .getByRole("slider", { name: "Animation speed", exact: true })
    .press("Home")
  await page.getByRole("button", { name: "Close style lab" }).click()
  const box = (await canvas.boundingBox())!
  // The field now reaches behind the live feed. Compare the static hero area
  // so a late activity update cannot masquerade as residual beam animation.
  const snapshot = (name = "current") =>
    page.screenshot({
      clip: { x: box.x, y: box.y, width: box.width, height: 430 },
      path: testInfo.outputPath(`${name}.png`),
    })
  expect(box.height).toBeGreaterThan(650)
  const onboarding = await page
    .getByRole("region", { name: "Connect your agent", exact: true })
    .boundingBox()
  expect(box.y + box.height).toBeGreaterThan(
    onboarding!.y + onboarding!.height + 100
  )
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: "Account and appearance" }).click()
    await page.getByRole("menuitem", { name: theme, exact: true }).click()
    await page.mouse.move(10, 800)
    // Closing controls can expose the larger field beneath the cursor. Let
    // that deliberate exit fade settle before taking the unlit reference.
    await page.waitForTimeout(1700)
    const resting = await snapshot(`${theme.toLowerCase()}-resting`)
    await page.mouse.move(box.x + box.width * 0.13, box.y + 150)
    await page.mouse.move(box.x + box.width * 0.23, box.y + 100, { steps: 10 })
    await expect.poll(async () => resting.equals(await snapshot())).toBe(false)
    await page.screenshot({
      path: testInfo.outputPath(`${theme.toLowerCase()}-prism.png`),
    })
    await page.mouse.move(10, 800)
    await expect.poll(async () => resting.equals(await snapshot())).toBe(true)
  }
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  await page
    .getByRole("slider", { name: "Pointer response", exact: true })
    .press("Home")
  await page.getByRole("button", { name: "Close style lab" }).click()
  const disabled = await snapshot()
  await page.mouse.move(box.x + box.width * 0.2, box.y + 100)
  expect(disabled.equals(await snapshot())).toBe(true)
  expect(errors).toEqual([])
})

test("vgpu variants reuse the device, pause offscreen, resize and recover from device loss", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(90000)
  expect((await (await request.get("/health")).json()).environment).toBe("test")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const devices: GPUDevice[] = []
    const work = { submissions: 0 }
    Object.assign(window, { heroDevices: devices, heroWork: work })
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async (options) => {
      const adapter = await request(options)
      if (adapter) {
        const create = adapter.requestDevice.bind(adapter)
        adapter.requestDevice = async (options) => {
          const device = await create(options)
          devices.push(device)
          const submit = device.queue.submit.bind(device.queue)
          device.queue.submit = (commands) => {
            work.submissions++
            submit(commands)
          }
          return device
        }
      }
      return adapter
    }
  })
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto("/")
  const effect = page.locator('[data-slot="hero-particles"]')
  await expect(effect).toHaveAttribute("data-render-state", "running")
  const deviceCount = await page.evaluate(
    () => (window as unknown as { heroDevices: GPUDevice[] }).heroDevices.length
  )
  const canvas = await page.locator('[data-slot="hero-canvas"]').elementHandle()
  const snapshot = () => page.locator('[data-slot="hero-canvas"]').screenshot()
  const movingFrame = await snapshot()
  await expect
    .poll(async () => movingFrame.equals(await snapshot()))
    .toBe(false)
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      value: true,
      configurable: true,
    })
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(effect).toHaveAttribute("data-render-state", "paused")
  // The larger canvas also sits behind live activity text. Check GPU work
  // directly so unrelated feed updates cannot invalidate the pause assertion.
  const submissions = () =>
    page.evaluate(
      () =>
        (window as unknown as { heroWork: { submissions: number } }).heroWork
          .submissions
    )
  const pausedWork = await submissions()
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      )
  )
  expect(await submissions()).toBe(pausedWork)
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden")
    document.dispatchEvent(new Event("visibilitychange"))
  })
  await expect(effect).toHaveAttribute("data-render-state", "running")
  for (const theme of ["Light", "Dark"]) {
    await page.getByRole("button", { name: "Account and appearance" }).click()
    await page.getByRole("menuitem", { name: theme, exact: true }).click()
    for (const [name, value] of [
      ["Liquid currents", "constellation"],
      ["Wave field", "wave"],
      ["Orbital streams", "orbit"],
      ["Notebook assembly", "notebook"],
    ]) {
      await page.getByRole("button", { name: "Style lab", exact: true }).click()
      const group = page
        .locator("details")
        .filter({ has: page.getByText("Hero animation", { exact: true }) })
      if ((await group.getAttribute("open")) === null)
        await group.locator("summary").click()
      await page.getByRole("combobox", { name: "Particle effect" }).click()
      await page.getByRole("option", { name, exact: true }).click()
      await page.getByRole("button", { name: "Close style lab" }).click()
      await expect(effect).toHaveAttribute("data-variant", value)
      await expect(effect).toHaveAttribute("data-render-state", "running")
      expect(
        await canvas!.evaluate(
          (node) => node === document.querySelector('[data-slot="hero-canvas"]')
        )
      ).toBe(true)
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
          )
      )
      await page.screenshot({
        path: testInfo.outputPath(`${theme.toLowerCase()}-${value}.png`),
      })
    }
  }
  expect(
    await page.evaluate(
      () =>
        (window as unknown as { heroDevices: GPUDevice[] }).heroDevices.length
    )
  ).toBe(deviceCount)
  const panel = page.locator('[data-slot="sidebar-inset"]')
  await panel.evaluate((node) => node.scrollTo(0, 1000))
  await expect(effect).toHaveAttribute("data-render-state", "paused")
  await panel.evaluate((node) => node.scrollTo(0, 0))
  await expect(effect).toHaveAttribute("data-render-state", "running")
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(effect).toHaveAttribute("data-render-state", "running")
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth
    )
  ).toBe(true)
  await page.screenshot({ path: testInfo.outputPath("mobile-dark.png") })
  await page.evaluate(() => {
    const devices = (window as unknown as { heroDevices: GPUDevice[] })
      .heroDevices
    devices.at(-1)!.destroy()
  })
  await expect(effect).toHaveAttribute("data-render-state", "fallback")
  await expect(effect.locator("svg")).toBeVisible()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page
    .getByRole("link", { name: "Explore the wiki", exact: true })
    .click()
  await expect(page).toHaveURL(/\/wiki$/)
  await page.goBack()
  await expect(page).toHaveURL(/\/$/)
  await expect(effect).toHaveAttribute("data-render-state", "running")
  await page.emulateMedia({ reducedMotion: "reduce" })
  await expect(effect).toHaveAttribute("data-render-state", "fallback")
  await expect(page.locator('[data-slot="hero-canvas"]')).toHaveCount(0)
  expect(errors).toEqual([])
})

test("navigation during GPU initialization disposes the late device", async ({
  page,
  request,
}) => {
  expect((await (await request.get("/health")).json()).environment).toBe("test")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    const devices: GPUDevice[] = []
    const pending: Array<() => void> = []
    let released = false
    Object.assign(window, {
      heroInitialization: {
        devices,
        release() {
          released = true
          pending.forEach((resolve) => resolve())
        },
      },
    })
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async (options) => {
      const adapter = await request(options)
      if (adapter) {
        const create = adapter.requestDevice.bind(adapter)
        adapter.requestDevice = async (options) => {
          const device = await create(options)
          devices.push(device)
          if (!released)
            await new Promise<void>((resolve) => pending.push(resolve))
          return device
        }
      }
      return adapter
    }
  })
  await page.goto("/")
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as {
              heroInitialization: { devices: GPUDevice[] }
            }
          ).heroInitialization.devices.length
      )
    )
    .toBeGreaterThan(0)
  await page
    .getByRole("link", { name: "Explore the wiki", exact: true })
    .click()
  await expect(page).toHaveURL(/\/wiki$/)
  const reasons = await page.evaluate(async () => {
    const gate = (
      window as unknown as {
        heroInitialization: { devices: GPUDevice[]; release: () => void }
      }
    ).heroInitialization
    gate.release()
    return await Promise.all(
      gate.devices.map(async (device) => (await device.lost).reason)
    )
  })
  expect(reasons.every((reason) => reason === "destroyed")).toBe(true)
  expect(errors).toEqual([])
})
