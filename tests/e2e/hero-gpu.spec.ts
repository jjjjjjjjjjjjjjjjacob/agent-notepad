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

type ParticleSample = { x: number; y: number; speed: number }

test("mouse stirs only particles and clicks scatter locally with persistent, decaying momentum", async ({
  page,
  request,
}, testInfo) => {
  expect((await (await request.get("/health")).json()).environment).toBe("test")
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  await page.addInitScript(() => {
    localStorage.setItem(
      "agent-notepad:style:v1",
      JSON.stringify({
        version: 1,
        values: { heroSpeed: 0, heroPointer: 0 },
      })
    )
    // Read the actual GPU positions to distinguish radial scatter from a
    // visual overlay, ambient animation, or a force affecting the whole field.
    const request = navigator.gpu.requestAdapter.bind(navigator.gpu)
    navigator.gpu.requestAdapter = async (options) => {
      const adapter = await request(options)
      if (adapter) {
        const create = adapter.requestDevice.bind(adapter)
        adapter.requestDevice = async (options) => {
          const device = await create(options)
          let particles: GPUBuffer
          const createBuffer = device.createBuffer.bind(device)
          device.createBuffer = (descriptor) => {
            const buffer = createBuffer(descriptor)
            if (
              descriptor.size === 18000 * 32 &&
              descriptor.usage & GPUBufferUsage.STORAGE
            )
              particles = buffer
            return buffer
          }
          Object.assign(window, {
            async readHeroParticles() {
              const readback = createBuffer({
                size: 3000 * 32,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              })
              const encoder = device.createCommandEncoder()
              encoder.copyBufferToBuffer(
                particles,
                0,
                readback,
                0,
                readback.size
              )
              device.queue.submit([encoder.finish()])
              await readback.mapAsync(GPUMapMode.READ)
              const data = new Float32Array(readback.getMappedRange())
              const samples = Array.from({ length: 3000 }, (_, i) => ({
                x: data[i * 8],
                y: data[i * 8 + 1],
                speed: Math.hypot(data[i * 8 + 6], data[i * 8 + 7]),
              }))
              readback.unmap()
              readback.destroy()
              return samples
            },
          })
          return device
        }
      }
      return adapter
    }
  })
  const readParticles = () =>
    page.evaluate(() =>
      (
        window as unknown as { readHeroParticles(): Promise<ParticleSample[]> }
      ).readHeroParticles()
    )
  const settle = () =>
    expect
      .poll(async () =>
        Math.max(...(await readParticles()).map((p) => p.speed))
      )
      .toBeLessThan(0.003)
  await page.setViewportSize({ width: 1440, height: 1100 })
  await page.goto("/")
  const effect = page.locator('[data-slot="hero-particles"]')
  const canvas = page.locator('[data-slot="hero-canvas"]')
  await expect(effect).toHaveAttribute("data-render-state", "running")
  const box = (await canvas.boundingBox())!
  expect(box.height).toBeGreaterThan(650)
  const onboarding = await page
    .getByRole("region", { name: "Connect your agent", exact: true })
    .boundingBox()
  expect(box.y + box.height).toBeGreaterThan(
    onboarding!.y + onboarding!.height + 100
  )

  for (const [theme, x] of [
    ["Light", 0.2],
    ["Dark", 0.8],
  ] as const) {
    await page.getByRole("button", { name: "Account and appearance" }).click()
    await page.getByRole("menuitem", { name: theme, exact: true }).click()
    const initial = await readParticles()
    const click = { x: box.width * x, y: 180 }
    await page.mouse.click(box.x + click.x, box.y + click.y)
    await page.waitForTimeout(150)
    const scattered = await readParticles()
    const near = initial
      .map((p, i) => ({
        i,
        dx: p.x * box.width - click.x,
        dy: p.y * box.height - click.y,
      }))
      .filter(
        (p) => Math.hypot(p.dx, p.dy) > 20 && Math.hypot(p.dx, p.dy) < 110
      )
    expect(near.length).toBeGreaterThan(20)
    const travel = (samples: ParticleSample[], i: number) => ({
      x: (samples[i].x - initial[i].x) * box.width,
      y: (samples[i].y - initial[i].y) * box.height,
    })
    const outward = near.filter((p) => {
      const d = travel(scattered, p.i)
      return d.x * p.dx + d.y * p.dy > 0
    })
    expect(outward.length / near.length).toBeGreaterThan(0.95)
    const meanTravel = (samples: ParticleSample[]) =>
      near.reduce((sum, p) => {
        const d = travel(samples, p.i)
        return sum + Math.hypot(d.x, d.y)
      }, 0) / near.length
    expect(meanTravel(scattered)).toBeGreaterThan(8)
    const distant = initial
      .map((p, i) => ({
        i,
        distance: Math.hypot(
          p.x * box.width - click.x,
          p.y * box.height - click.y
        ),
      }))
      .filter((p) => p.distance > 300)
    expect(
      Math.max(
        ...distant.map((p) =>
          Math.hypot(travel(scattered, p.i).x, travel(scattered, p.i).y)
        )
      )
    ).toBeLessThan(0.1)
    await page.screenshot({
      path: testInfo.outputPath(`${theme.toLowerCase()}-scatter.png`),
    })
    await settle()
    // They come to rest farther out, rather than springing back into place.
    expect(meanTravel(await readParticles())).toBeGreaterThan(
      meanTravel(scattered)
    )
  }

  // A real button inside the field remains usable and does not inject a pulse.
  await page.getByRole("button", { name: "Copy prompt", exact: true }).click()
  expect(Math.max(...(await readParticles()).map((p) => p.speed))).toBeLessThan(
    0.003
  )
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  await page.screenshot({
    path: testInfo.outputPath("appearance-controls.png"),
  })
  await page
    .getByRole("slider", { name: "Scatter radius", exact: true })
    .press("End")
  await page
    .getByRole("slider", { name: "Interaction settling", exact: true })
    .press("End")
  await page.screenshot({
    path: testInfo.outputPath("interaction-controls.png"),
  })
  await page.getByRole("button", { name: "Close style lab" }).click()
  const wideInitial = await readParticles()
  const wideClick = { x: box.width * 0.5, y: 216 }
  await page.mouse.click(box.x + wideClick.x, box.y + wideClick.y)
  await page.waitForTimeout(150)
  const wideScatter = await readParticles()
  const outerRing = wideInitial
    .map((p, i) => ({
      i,
      distance: Math.hypot(
        p.x * box.width - wideClick.x,
        p.y * box.height - wideClick.y
      ),
    }))
    .filter((p) => p.distance > 300 && p.distance < 420)
  // Increasing radius reaches particles beyond the original 250px area.
  expect(
    outerRing.filter((p) => wideScatter[p.i].speed > 0.02).length
  ).toBeGreaterThan(20)
  const meanSpeed = (samples: ParticleSample[]) =>
    outerRing.reduce((sum, p) => sum + samples[p.i].speed, 0) / outerRing.length
  await page.waitForTimeout(300)
  const retainedMomentum =
    meanSpeed(await readParticles()) / meanSpeed(wideScatter)
  // Three-second settling retains momentum longer than the default setting.
  expect(retainedMomentum).toBeGreaterThan(0.4)
  expect(retainedMomentum).toBeLessThan(0.8)
  await settle()
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  const response = page.getByRole("slider", {
    name: "Pointer response",
    exact: true,
  })
  for (let i = 0; i < 5; i++) await response.press("ArrowRight")
  await page.getByRole("button", { name: "Close style lab" }).click()
  const beforeHover = await readParticles()
  await page.mouse.move(box.x + box.width * 0.15, box.y + 150)
  await page.mouse.move(box.x + box.width * 0.3, box.y + 230, { steps: 15 })
  await expect
    .poll(
      async () =>
        (await readParticles()).filter(
          (p, i) =>
            Math.hypot(
              (p.x - beforeHover[i].x) * box.width,
              (p.y - beforeHover[i].y) * box.height
            ) > 2
        ).length
    )
    .toBeGreaterThan(20)
  await page.screenshot({ path: testInfo.outputPath("particle-hover.png") })
  await page.mouse.move(10, 800)
  await settle()

  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  await page
    .getByRole("slider", { name: "Pointer response", exact: true })
    .press("Home")
  await page
    .getByRole("slider", { name: "Click scatter", exact: true })
    .press("Home")
  await page.getByRole("button", { name: "Close style lab" }).click()
  await page.mouse.move(10, 800)
  await settle()
  // Let visible motion settle; tiny residual velocity may still decay with
  // the longest settling setting, but disabled input must add no movement.
  await page.waitForTimeout(3500)
  const disabled = await readParticles()
  await page.mouse.click(box.x + box.width * 0.2, box.y + 180)
  await page.waitForTimeout(200)
  const afterDisabledClick = await readParticles()
  expect(
    Math.max(
      ...afterDisabledClick.map((p, i) =>
        Math.hypot(
          (p.x - disabled[i].x) * box.width,
          (p.y - disabled[i].y) * box.height
        )
      )
    )
  ).toBeLessThan(0.01)
  expect(Math.max(...afterDisabledClick.map((p) => p.speed))).toBeLessThan(
    0.001
  )
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
    const work = { submissions: 0, instances: 0 }
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
          const encode = device.createCommandEncoder.bind(device)
          device.createCommandEncoder = (options) => {
            const encoder = encode(options)
            const begin = encoder.beginRenderPass.bind(encoder)
            encoder.beginRenderPass = (descriptor) => {
              const pass = begin(descriptor)
              const draw = pass.draw.bind(pass)
              pass.draw = (
                vertices,
                instances = 1,
                firstVertex,
                firstInstance
              ) => {
                work.instances = instances
                draw(vertices, instances, firstVertex, firstInstance)
              }
              return pass
            }
            return encoder
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
  const instanceCount = () =>
    page.evaluate(
      () =>
        (window as unknown as { heroWork: { instances: number } }).heroWork
          .instances
    )
  await expect.poll(instanceCount).toBe(6000)
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await page.getByText("Hero animation", { exact: true }).click()
  await page
    .getByRole("slider", { name: "Particle density", exact: true })
    .press("End")
  await expect.poll(instanceCount).toBe(18000)
  await page.getByRole("button", { name: "Close style lab" }).click()
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
  await expect.poll(instanceCount).toBe(3000)
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
