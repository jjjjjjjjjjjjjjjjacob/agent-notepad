import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, writeFile, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

const fixturePath = resolve(
  ".artifacts/test-backend/convex/commerceBrowserFixture.ts"
)
// This admin-only fixture is written exclusively into the isolated backend copy.
// It is never a function in the deployable application.
const fixture = `import { internalMutation } from "./_generated/server"
import { v } from "convex/values"
export const grant = internalMutation({ args: { agentId: v.id("agents") }, handler: async (ctx, {agentId}) => {
  if (process.env.SITE_URL !== "http://127.0.0.1:4242") throw new Error("Isolated backend required")
  const agent = await ctx.db.get(agentId)
  if (!agent?.slug.startsWith("commerce-e2e-")) throw new Error("Synthetic agent required")
  const existing = await ctx.db.query("privateSpaces").withIndex("by_owner", q => q.eq("ownerAgentId", agentId)).first()
  if (existing) return existing._id
  const spaceId = await ctx.db.insert("privateSpaces", { ownerAgentId: agentId, name: "Browser private notebook", kind: "notepad", mode: "test", channels: ["general"], bytes: 0, entries: 0, updatedAt: Date.now() })
  await ctx.db.insert("privateMembers", { spaceId, agentId, role: "owner" })
  const accountId = await ctx.db.insert("commerceAccounts", { agentId, mode: "test" })
  await ctx.db.insert("purchases", { agentId, accountId, mode: "test", product: "private_notepad", purchaseMode: "one_time", payment: "checkout", amountCents: 500, name: "Browser fixture", spaceId, requestKey: "fixture", fingerprint: "fixture", createdAt: Date.now(), status: "paid", paidFrom: Date.now(), paidThrough: Date.now() + 86400000, syncGeneration: 0, nextSyncAt: 8640000000000000 })
  return spaceId
}})`
test.afterAll(async () => {
  await rm(fixturePath, { force: true })
})

test("linked managers use private spaces; REST and MCP protect nonmembers", async ({
  page,
  request,
}) => {
  test.setTimeout(180_000)
  page.setDefaultTimeout(15_000)
  const health = await (await request.get("/health")).json()
  expect(health.environment).toBe("test")
  expect(health.backend).toBe("127.0.0.1:3215")
  const suffix = crypto.randomUUID().slice(0, 8)
  const registered = await request.post("/api/v1/agents", {
    data: { name: "Private browser agent", slug: `commerce-e2e-${suffix}` },
  })
  expect(registered.status()).toBe(201)
  const agent = (await registered.json()).data
  await writeFile(fixturePath, fixture)
  const env = { ...process.env }
  delete env.CONVEX_DEPLOYMENT
  delete env.CONVEX_DEPLOY_KEY
  let spaceId = ""
  await expect
    .poll(
      async () => {
        try {
          const result = await promisify(execFile)(
            "bunx",
            [
              "convex",
              "run",
              "commerceBrowserFixture:grant",
              JSON.stringify({ agentId: agent.agentId }),
            ],
            { cwd: resolve(".artifacts/test-backend"), env, timeout: 15_000 }
          )
          spaceId = JSON.parse(result.stdout.trim())
          return true
        } catch {
          return false
        }
      },
      { timeout: 45_000, intervals: [1000, 2000] }
    )
    .toBe(true)
  await page.goto("/account")
  await page.getByRole("tab", { name: "Create account", exact: true }).click()
  await page.getByLabel("Account name").fill("Private test manager")
  await page
    .getByLabel("Email", { exact: true })
    .fill(`commerce-${suffix}@example.invalid`)
  await page
    .getByLabel("Password", { exact: true })
    .fill(`test-private-${crypto.randomUUID()}`)
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(
    page.getByText(`Signed in as commerce-${suffix}@example.invalid`)
  ).toBeVisible()
  const headers = { Authorization: `Bearer ${agent.apiKey}` }
  const linking = await request.post("/api/v1/agents/link", {
    headers,
    data: {},
  })
  await page
    .getByLabel("Linking code", { exact: true })
    .fill((await linking.json()).data.linkingCode)
  await page.getByRole("button", { name: "Link agent", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Private spaces and support" })
  ).toBeVisible()
  await page.getByRole("link", { name: "Open space", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Browser private notebook" })
  ).toBeVisible()
  const confidential = `Confidential orchid ${suffix}`
  await page.getByLabel("Title", { exact: true }).fill("Private observation")
  await page.getByLabel("Private text", { exact: true }).fill(confidential)
  await page.getByRole("button", { name: "Save note", exact: true }).click()
  await expect(page.getByText(confidential, { exact: true })).toBeVisible()
  await page.getByRole("button", { name: "Edit", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Edit entry", exact: true })
  ).toBeVisible()
  await page
    .getByLabel("Private text", { exact: true })
    .fill(`${confidential} revised`)
  await expect(
    page.getByRole("heading", { name: "Edit entry", exact: true })
  ).toBeVisible()
  await page.getByRole("button", { name: "Save revision", exact: true }).click()
  await expect(
    page.getByText(`${confidential} revised`, { exact: true })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Revision history", exact: true })
    .click()
  await expect(page.getByText("Revision 1 ·", { exact: false })).toBeVisible()
  const download = page.waitForEvent("download")
  await page.getByRole("button", { name: "Export current entries" }).click()
  expect((await download).suggestedFilename()).toContain("private-space-")
  const client = new Client({ name: "commerce-test", version: "1" })
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1:4242/mcp"), {
      requestInit: { headers },
    })
  )
  try {
    const result = await client.callTool({
      name: "get_private_entries",
      arguments: { spaceId },
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.stringify(result)).toContain(confidential)
  } finally {
    await client.close()
  }
  expect(
    (await request.get(`/api/v1/private_entries?spaceId=${spaceId}`)).status()
  ).toBe(401)
  const publicSearch = await request.get(
    `/api/v1/search?query=${encodeURIComponent(confidential)}`
  )
  expect(JSON.stringify((await publicSearch.json()).data)).not.toContain(
    confidential
  )
  const profile = await (
    await request.get(`/api/v1/agents/commerce-e2e-${suffix}`)
  ).json()
  expect(profile.data.humanVerified).toBe(true)
  expect(JSON.stringify(profile)).not.toContain(
    `commerce-${suffix}@example.invalid`
  )
  await mkdir(".artifacts/commerce", { recursive: true })
  for (const theme of ["light", "dark"]) {
    await page.evaluate(
      (value) =>
        document.documentElement.classList.toggle("dark", value === "dark"),
      theme
    )
    await page.evaluate(async () => {
      await Promise.allSettled(
        document
          .getAnimations()
          .filter(
            (animation) => animation.effect?.getTiming().iterations !== Infinity
          )
          .map((animation) => animation.finished)
      )
    })
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 })
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1
        )
      ).toBe(true)
      const audit = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(
        audit.violations.map((v) => ({
          id: v.id,
          targets: v.nodes.map((n) => n.target),
        }))
      ).toEqual([])
      await page.screenshot({
        path: `.artifacts/commerce/private-${theme}-${width}.png`,
        fullPage: true,
      })
    }
  }
  await page.goto("/billing/return")
  await expect(
    page.getByRole("heading", { name: "Check your payment status" })
  ).toBeVisible()
})
