import { test, expect } from "@playwright/test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const enabled = (process.env.PLACE_ENABLED ?? "true") === "true"

test(`Place rollout is ${enabled ? "enabled" : "disabled"} across pages, REST, and MCP`, async ({
  page,
  request,
}) => {
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
  await page.goto("/account")
  await expect(page.locator('a[href="/place"]')).toHaveCount(enabled ? 1 : 0)
  await expect(page.locator('a[href="/account/place"]')).toHaveCount(
    enabled ? 1 : 0
  )
  await page.keyboard.press("Control+k")
  await expect(
    page.getByRole("option", { name: "Pixels", exact: true })
  ).toHaveCount(enabled ? 1 : 0)
  await page.keyboard.press("Escape")

  for (const path of ["/place", "/account/place"]) {
    expect((await request.get(path)).status()).toBe(enabled ? 200 : 404)
  }
  const paths = (await (await request.get("/openapi.json")).json()).paths
  expect(Object.hasOwn(paths, "/place_config")).toBe(enabled)
  expect(Object.hasOwn(paths, "/commands/place_create")).toBe(enabled)
  const guide = await (await request.get("/for-agents.md")).text()
  expect(guide.includes("/account/place")).toBe(enabled)
  for (const origin of ["", "http://127.0.0.1:3216"]) {
    expect((await request.get(`${origin}/api/v1/place_config`)).status()).toBe(
      enabled ? 200 : 404
    )
    if (!enabled) {
      const blocked = await request.post(
        `${origin}/api/v1/commands/place_create`,
        {
          data: { kind: "initial", title: "Blocked", pixelCount: 1 },
        }
      )
      expect(blocked.status()).toBe(404)
      expect((await blocked.json()).error.code).toBe("NOT_FOUND")
    }
  }

  const client = new Client({ name: "place-flag-test", version: "1.0.0" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4242/mcp"))
  )
  try {
    const { tools } = await client.listTools()
    expect(tools.some((tool) => tool.name === "get_place_config")).toBe(enabled)
    expect(tools.some((tool) => tool.name === "place_create")).toBe(enabled)
    expect(tools.some((tool) => tool.name === "get_integrity_evidence")).toBe(
      true
    )
    const result = await client.callTool({
      name: "get_place_config",
      arguments: {},
    })
    expect(Boolean(result.isError)).toBe(!enabled)
  } finally {
    await client.close()
  }
})
