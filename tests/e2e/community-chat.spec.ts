import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { readFile } from "node:fs/promises"
test.beforeEach(async ({ request }) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
})
test("a fresh MCP agent discovers a community and publishes its first post and message", async () => {
  const slug = `mcp-community-${crypto.randomUUID().slice(0, 8)}`
  async function connect(key?: string) {
    const client = new Client({ name: "community-workflow", version: "1.0.0" })
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4242/mcp"), {
        requestInit: { headers: key ? { Authorization: `Bearer ${key}` } : {} },
      })
    )
    return client
  }
  async function invoke<T>(
    client: Client,
    name: string,
    args: Record<string, unknown>
  ) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError, name).not.toBe(true)
    return (result.structuredContent as { data: T }).data
  }
  const anonymous = await connect()
  let key: string
  try {
    key = (
      await invoke<{ apiKey: string }>(anonymous, "register_agent", {
        name: "Community MCP agent",
        slug,
      })
    ).apiKey
  } finally {
    await anonymous.close()
  }
  const client = await connect(key)
  try {
    const created = await invoke<{ id: string }>(client, "create_space", {
      input: { kind: "server", name: "MCP community", slug },
      idempotencyKey: `${slug}-create`,
    })
    const directory = await invoke<{
      items: { id: string; community: { slug: string } }[]
    }>(client, "get_channels", {
      community: slug,
      includeEmpty: true,
      limit: 1,
    })
    expect(directory.items).toHaveLength(1)
    expect(directory.items[0].community.slug).toBe(slug)
    await invoke(client, "publish", {
      input: {
        kind: "post",
        title: "First community post",
        body: "An agent contribution through MCP.",
        spaceId: created.id,
      },
      idempotencyKey: `${slug}-post`,
    })
    const args = {
      input: {
        kind: "message",
        title: "First channel message",
        body: "Hello from a freshly registered agent.",
        spaceId: directory.items[0].id,
      },
      idempotencyKey: `${slug}-message`,
    }
    const first = await invoke<{ id: string }>(client, "publish", args)
    expect((await invoke<{ id: string }>(client, "publish", args)).id).toBe(
      first.id
    )
    expect(
      (
        await invoke<{ items: unknown[] }>(client, "get_channels", {
          community: slug,
        })
      ).items
    ).toHaveLength(1)
    const invalid = await client.callTool({
      name: "publish",
      arguments: {
        input: { ...args.input, spaceId: created.id },
        idempotencyKey: `${slug}-invalid`,
      },
    })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid.structuredContent)).toContain("VALIDATION")
  } finally {
    await client.close()
  }
})
test("community posts and chat connect through scoped sidebar navigation", async ({
  page,
  request,
}) => {
  const slug = `navigation-${crypto.randomUUID().slice(0, 8)}`
  const identity = (
    await (
      await request.post("/api/v1/agents", {
        data: { name: "Navigation agent", slug },
      })
    ).json()
  ).data
  const headers = { Authorization: `Bearer ${identity.apiKey}` }
  const community = (
    await (
      await request.post("/api/v1/commands/create_space", {
        headers,
        data: { kind: "community", name: "Navigation community", slug },
      })
    ).json()
  ).data
  expect(community.defaultChannel.id).toBeTruthy()
  expect((await request.get(`/chat/${slug}`)).url()).toContain(
    `/communities/${slug}?view=chat`
  )
  await page.goto(`/communities/${slug}`)
  await page
    .getByRole("navigation", { name: "Community sections" })
    .getByRole("link", { name: "Chat", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "#general", exact: true })
  ).toBeVisible()
  await page
    .getByRole("heading", { name: "#general", exact: true })
    .getByRole("link")
    .click()
  await expect(
    page.getByRole("navigation", { name: "Community channels" })
  ).toBeVisible()
  await expect(
    page
      .getByRole("navigation", { name: "Primary navigation" })
      .getByRole("link", { name: "Home", exact: true })
  ).toBeVisible()
  await page.reload()
  await expect(
    page.getByRole("navigation", { name: "Community channels" })
  ).toBeVisible()
  await page
    .getByRole("navigation", { name: "Primary navigation" })
    .getByRole("link", { name: "Home", exact: true })
    .click()
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
  const message = {
    kind: "message",
    spaceId: community.defaultChannel.id,
    title: "Discovery test",
    body: "A new public channel contribution.",
  }
  const first = await request.post("/api/v1/commands/publish", {
    headers: { ...headers, "Idempotency-Key": `${slug}-message` },
    data: message,
  })
  expect(first.ok()).toBe(true)
  const channels = await (
    await request.get(`/api/v1/channels?community=${slug}`)
  ).json()
  expect(channels.data.items).toHaveLength(1)
  expect(channels.data.items[0].lastMessage.excerpt).toBe(message.body)
  await page.goto(`/chat?community=${slug}`)
  await expect(page.getByText(message.body, { exact: false })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`/chat/${community.defaultChannel.slug}`)
  await page.getByRole("button", { name: "Expand sidebar" }).click()
  await page
    .getByRole("dialog")
    .getByRole("link", { name: "Discover public channels" })
    .click()
  await expect(page.getByRole("dialog")).toHaveCount(0)
  await expect(
    page.getByRole("heading", { name: "Chat", exact: true })
  ).toBeVisible()
})
test("style lab persists, resets, validates imports and stays keyboard accessible", async ({
  page,
}) => {
  await page.goto("/wiki")
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  const panel = page.getByRole("complementary", {
    name: "Development styling panel",
  })
  await expect(panel).toBeVisible()
  await panel.getByRole("combobox", { name: "Body font", exact: true }).click()
  await page.getByRole("option", { name: "System sans", exact: true }).click()
  await expect
    .poll(() =>
      page.locator("body").evaluate((el) => getComputedStyle(el).fontFamily)
    )
    .toContain("system-ui")
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((el) => el.style.getPropertyValue("--ui-font-body"))
    )
    .toBe("system-ui, sans-serif")
  await page.reload()
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((el) => el.style.getPropertyValue("--ui-font-body"))
    )
    .toBe("system-ui, sans-serif")
  await page.getByRole("button", { name: "Style lab", exact: true }).click()
  await panel.getByLabel("Import JSON").setInputFiles({
    name: "bad.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1,"values":{"bodySize":-20}}'),
  })
  await expect(panel.getByRole("status")).toContainText("Invalid value")
  await panel.getByLabel("Import JSON").setInputFiles({
    name: "valid.json",
    mimeType: "application/json",
    buffer: Buffer.from('{"version":1,"values":{"bodyFont":"manrope"}}'),
  })
  await expect(panel.getByRole("status")).toContainText("Preset imported")
  await expect(
    panel.getByRole("combobox", { name: "Body font", exact: true })
  ).toContainText("Manrope")
  const downloadReady = page.waitForEvent("download")
  await panel.getByRole("button", { name: "Export JSON" }).click()
  const download = await downloadReady
  expect(
    JSON.parse(await readFile((await download.path())!, "utf8"))
  ).toMatchObject({ version: 1, values: { bodyFont: "manrope" } })
  await panel.getByRole("button", { name: "Reset all" }).click()
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((el) => el.style.getPropertyValue("--ui-font-body"))
    )
    .toBe("var(--font-source-sans)")
  const result = await new AxeBuilder({ page })
    .include("#style-panel")
    .withTags(["wcag2a", "wcag2aa"])
    .analyze()
  expect(
    result.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.html),
    }))
  ).toEqual([])
  await page.keyboard.press("Escape")
  await expect(panel).toHaveCount(0)
  await expect(
    page.getByRole("button", { name: "Style lab", exact: true })
  ).toBeFocused()
})
