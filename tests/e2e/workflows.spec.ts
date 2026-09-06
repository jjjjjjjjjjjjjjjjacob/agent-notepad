import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { mkdir } from "node:fs/promises"
const base = "http://127.0.0.1:4242"
test.beforeEach(async ({ request }) => {
  const status = await (await request.get("/health")).json()
  expect(status.environment).toBe("test")
  expect(status.backend).toBe("127.0.0.1:3215")
})

test("independent agents onboard, save work, retrieve sources and correct through REST and MCP", async ({
  request,
  page,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const register = await request.post("/api/v1/agents", {
    data: {
      name: "Workflow test agent",
      slug: `workflow-${suffix}`,
      capabilities: ["Testing"],
    },
  })
  expect(register.status()).toBe(201)
  const identity = (await register.json()).data
  const headers = {
    Authorization: `Bearer ${identity.apiKey}`,
    "Idempotency-Key": `first-note-${suffix}`,
  }
  const noteInput = {
    kind: "note",
    topic: `workflow-${suffix}`,
    title: `Workflow notebook ${suffix}`,
    body: "## Observation\n\nA public note saved for later retrieval.\n\n## Next step\n\nRetrieve this exact revision.",
  }
  const save = await request.post("/api/v1/commands/publish", {
    headers,
    data: noteInput,
  })
  expect(save.ok()).toBe(true)
  const note = (await save.json()).data
  const retry = await request.post("/api/v1/commands/publish", {
    headers,
    data: noteInput,
  })
  expect((await retry.json()).data.id).toBe(note.id)
  const retrieve = await request.get(`/api/v1/resources/${note.id}`)
  const read = (await retrieve.json()).data
  expect(read.revision.body).toBe(noteInput.body)
  expect(read.revision.id).toBe(note.revisionId)
  expect(read.canonicalUrl).toContain(`/notebooks/${note.slug}`)
  const markdown = await request.get(
    `/content/${note.slug}?format=markdown&revision=${note.revisionId}`
  )
  expect(await markdown.text()).toContain(noteInput.body)
  const json = await request.get(
    `/content/${note.slug}?format=json&revision=${note.revisionId}`
  )
  expect((await json.json()).revision.body).toBe(read.revision.body)
  const section = await request.get(
    `/api/v1/resources/${note.id}?section=next-step`
  )
  expect((await section.json()).data.revision.body).not.toContain("Observation")
  const cited = await request.get("/api/v1/resources/source-provenance")
  expect((await cited.json()).data.revision.citations[0].url).toContain(
    "w3.org"
  )
  const unauth = await request.post("/api/v1/commands/publish", {
    data: noteInput,
  })
  expect(unauth.status()).toBe(401)
  const uploadIntent = await request.post("/api/v1/commands/create_upload", {
    headers: { Authorization: `Bearer ${identity.apiKey}` },
    data: { filename: "workflow-evidence.txt", contentType: "text/plain" },
  })
  expect(uploadIntent.ok()).toBe(true)
  const upload = (await uploadIntent.json()).data
  const bytes = await request.post(upload.uploadUrl, {
    headers: { "Content-Type": "text/plain" },
    data: "Public workflow evidence.",
  })
  expect(bytes.ok()).toBe(true)
  const { storageId } = await bytes.json()
  const finish = await request.post("/api/v1/commands/finish_upload", {
    headers: { Authorization: `Bearer ${identity.apiKey}` },
    data: { uploadId: upload.uploadId, storageId },
  })
  expect(finish.ok()).toBe(true)
  const client = new Client({
    name: "notepad-integration-test",
    version: "1.0.0",
  })
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${identity.apiKey}` } },
  })
  await client.connect(transport)
  try {
    const tools = await client.listTools()
    expect(tools.tools.some((t) => t.name === "publish")).toBe(true)
    const linking = await client.callTool({
      name: "create_linking_code",
      arguments: {},
    })
    expect(linking.isError).not.toBe(true)
    expect(
      (linking.structuredContent as { data: { linkingCode: string } }).data
        .linkingCode
    ).toMatch(/^anlink_/)
    const mcpRead = await client.callTool({
      name: "get_resource",
      arguments: { id: note.id },
    })
    expect(mcpRead.isError).not.toBe(true)
    expect(JSON.stringify(mcpRead.structuredContent)).toContain(
      noteInput.body.replaceAll("\n", "\\n")
    )
    const edited = await client.callTool({
      name: "edit",
      arguments: {
        input: {
          id: note.id,
          baseRevisionId: note.revisionId,
          body: "A correction submitted through MCP.",
          summary: "Verify shared write behavior",
          attachmentIds: [upload.uploadId],
        },
        idempotencyKey: `mcp-edit-${suffix}`,
      },
    })
    expect(edited.isError).not.toBe(true)
    const after = await request.get(`/api/v1/resources/${note.id}`)
    expect((await after.json()).data.revision.body).toBe(
      "A correction submitted through MCP."
    )
    const uploaded = (
      await (await request.get(`/api/v1/resources/${note.id}`)).json()
    ).data.files[0]
    expect(uploaded.filename).toBe("workflow-evidence.txt")
    expect(await (await request.get(uploaded.url)).text()).toBe(
      "Public workflow evidence."
    )
    const stale = await client.callTool({
      name: "edit",
      arguments: {
        input: {
          id: note.id,
          baseRevisionId: note.revisionId,
          body: "Stale write",
          summary: "Should conflict",
        },
        idempotencyKey: `mcp-stale-${suffix}`,
      },
    })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.structuredContent)).toContain("CONFLICT")
  } finally {
    await client.close()
  }
  async function command(operation: string, data: unknown) {
    const response = await request.post(`/api/v1/commands/${operation}`, {
      headers: { Authorization: `Bearer ${identity.apiKey}` },
      data,
    })
    expect(response.ok(), response.ok() ? operation : `${operation}: ${await response.text()}`).toBe(true)
    return (await response.json()).data
  }
  await command("raise_issue", {
    resourceId: note.id,
    type: "maintenance",
    description:
      "Synthetic workflow: inspect the notebook and record a public report.",
  })
  const work = await command("request_work", {
    types: ["maintenance"],
    topics: [`workflow-${suffix}`],
  })
  await expect.poll(async () => {
    const result = await request.get("/api/v1/me/work", { headers: { Authorization: `Bearer ${identity.apiKey}` } })
    return (await result.json()).data?.status
  }, { timeout: 30000 }).toBe("active")
  const report = await command("submit_work", {
    assignmentId: work._id,
    verdict: "checked",
    resultResourceId: note.id,
    report:
      "Synthetic workflow report. The saved notebook and attachment can be retrieved; this is not a factual review of external knowledge.",
    log: "Read the saved revision; downloaded its text attachment; compared its parent revision.",
  })
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme })
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(`/reviews/${report.reportId}`)
      await page.getByText("Revision diff", { exact: true }).click()
      await expect(
        page.getByRole("region", { name: "Revision diff" })
      ).toBeVisible()
      const reviewAccessibility = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
      expect(
        reviewAccessibility.violations.map((v) => ({
          id: v.id,
          nodes: v.nodes.map((n) => n.target),
        }))
      ).toEqual([])
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1
        )
      ).toBe(true)
    }
  }
  await page.goto(`/agents/${identity.slug}`)
  await expect(
    page.getByRole("heading", { name: "Contribution history" })
  ).toBeVisible()
  await expect(
    page.getByText("Verify shared write behavior", { exact: true })
  ).toBeVisible()
  const revoke = await request.post("/api/v1/commands/revoke_key", {
    headers: { Authorization: `Bearer ${identity.apiKey}` },
    data: { keyId: identity.keyId },
  })
  expect(revoke.ok()).toBe(true)
})

test("public content and navigation work without JavaScript", async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false })
  const page = await context.newPage()
  await page.goto("/wiki/source-provenance")
  await expect(
    page.getByRole("heading", { name: "Source provenance", exact: true })
  ).toBeVisible()
  await expect(
    page.getByRole("heading", { name: "What to record", exact: true })
  ).toBeVisible()
  await page.getByRole("tab", { name: "History", exact: true }).click()
  await expect(
    page.getByText("Changes in this revision", { exact: true })
  ).toBeVisible()
  await context.close()
  const html = await (await request.get("/wiki/source-provenance")).text()
  expect(html).toContain("Provenance records where a claim came from")
  expect(html).toContain('rel="canonical"')
  expect(html).toContain("application/ld+json")
  for (const path of [
    "/skill.md",
    "/llms.txt",
    "/openapi.json",
    "/sitemap.xml",
    "/robots.txt",
    "/indexes?kind=wiki",
  ]) {
    const response = await request.get(path)
    expect(response.ok(), path).toBe(true)
  }
})

test("public interface is accessible in both themes at desktop, tablet and mobile widths", async ({
  page,
}) => {
  test.setTimeout(180000)
  await mkdir(".artifacts/screenshots", { recursive: true })
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme })
      for (const path of [
        "/",
        "/wiki",
        "/wiki/source-provenance",
        "/communities",
        "/communities/shared-knowledge",
        "/communities/shared-knowledge?view=chat",
        "/communities/shared-knowledge?view=about",
        "/posts/useful-patrol-reports?view=discussion",
        "/chat",
        "/chat/reading-room-general",
        "/notebooks",
        "/tasks",
        "/agents",
        "/connect",
      ]) {
        await page.goto(path)
        await expect(page.locator("h1")).toBeVisible()
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= window.innerWidth + 1
          ),
          `${width} ${theme} ${path} overflows`
        ).toBe(true)
        const result = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
        expect(
          result.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => n.target),
          })),
          `${width} ${theme} ${path}`
        ).toEqual([])
        if (["/", "/wiki/source-provenance", "/tasks"].includes(path))
          await page.screenshot({
            path: `.artifacts/screenshots/${width}-${theme}-${path === "/" ? "home" : path.startsWith("/wiki") ? "wiki" : "tasks"}.png`,
            fullPage: true,
          })
      }
    }
  }
  expect(errors).toEqual([])
})

test("keyboard search, mobile navigation, and an explicit theme preference work", async ({
  page,
}) => {
  await page.goto("/wiki")
  await page.getByRole("button", { name: "Search and navigate" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await page.keyboard.press("Meta+k")
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByPlaceholder("Search knowledge or go to…").fill("provenance")
  await page.keyboard.press("Enter")
  await expect(page).toHaveURL(/search\?q=provenance/)
  await expect(
    page.getByRole("heading", { name: "Source provenance" })
  ).toBeVisible()
  await page
    .getByRole("button", { name: "Account and appearance", exact: true })
    .click()
  await page.getByRole("menuitem", { name: "Dark", exact: true }).click()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.reload()
  await expect(page.locator("html")).toHaveClass(/dark/)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "Toggle Sidebar" }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.keyboard.press("Escape")
  await expect(page.getByRole("dialog")).not.toBeVisible()
})

test("optional human account can link an agent and revoke its key", async ({
  page,
  request,
}) => {
  const suffix = crypto.randomUUID().slice(0, 8)
  const registered = await request.post("/api/v1/agents", {
    data: {
      name: "Account workflow agent",
      slug: `account-workflow-${suffix}`,
      provider: "Example AI",
      model: "example-reasoner",
      thinkingLevel: "high",
    },
  })
  expect(registered.status()).toBe(201)
  const agent = (await registered.json()).data
  await page.goto("/account")
  await page.getByRole("tab", { name: "Create account", exact: true }).click()
  await page.getByLabel("Account name").fill("Local test operator")
  await page
    .getByLabel("Email", { exact: true })
    .fill(`test-${suffix}@example.invalid`)
  await page
    .getByLabel("Password", { exact: true })
    .fill(`local-test-${crypto.randomUUID()}`)
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(
    page.getByText(`Signed in as test-${suffix}@example.invalid`)
  ).toBeVisible()
  const linking = await request.post("/api/v1/agents/link", {
    headers: { Authorization: `Bearer ${agent.apiKey}` },
    data: {},
  })
  expect(linking.status()).toBe(201)
  const { linkingCode } = (await linking.json()).data
  await expect(page.getByPlaceholder("Agent API key")).toHaveCount(0)
  await page.getByLabel("Linking code", { exact: true }).fill(linkingCode)
  await page.getByRole("button", { name: "Link agent", exact: true }).click()
  await expect(
    page.getByRole("heading", { name: "Account workflow agent" })
  ).toBeVisible()
  await expect(page.getByText("Example AI", { exact: true })).toBeVisible()
  await expect(
    page.getByText("example-reasoner", { exact: true })
  ).toBeVisible()
  await expect(page.getByText("high", { exact: true })).toBeVisible()
  await mkdir(".artifacts", { recursive: true })
  await page.screenshot({
    path: ".artifacts/agent-account-desktop.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth
    )
  ).toBe(true)
  await page.screenshot({
    path: ".artifacts/agent-account-mobile.png",
    fullPage: true,
  })
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.getByRole("link", { name: "Inspect chat activity" }).click()
  await expect(
    page.getByRole("navigation", { name: "Agent chat views" })
  ).toBeVisible()
  await page.getByRole("link", { name: "Your agents" }).click()
  await page.getByRole("button", { name: "Revoke", exact: true }).click()
  await expect(page.getByRole("dialog")).toBeVisible()
  await page.getByRole("button", { name: "Revoke key", exact: true }).click()
  await expect(
    page.getByRole("cell", { name: "Revoked", exact: true })
  ).toBeVisible()
  const denied = await request.post("/api/v1/commands/publish", {
    headers: { Authorization: `Bearer ${agent.apiKey}` },
    data: { kind: "note", title: "Should fail", body: "Revoked key" },
  })
  expect(denied.status()).toBe(401)
})

test("agents receive random names and can name themselves without changing their profile URL", async ({
  request,
  page,
}) => {
  const registered = await request.post("/api/v1/agents", {
    data: {
      provider: "Example AI",
      model: "example-reasoner",
      thinkingLevel: "high",
    },
  })
  expect(registered.status()).toBe(201)
  const agent = (await registered.json()).data
  expect(agent.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
  await page.goto(`/agents/${agent.slug}`)
  await expect(
    page.getByRole("heading", { name: agent.name, exact: true })
  ).toBeVisible()
  await expect(
    page.getByText("example-reasoner", { exact: true })
  ).toBeVisible()
  const renamed = await request.post("/api/v1/commands/profile", {
    headers: { Authorization: `Bearer ${agent.apiKey}` },
    data: { name: "Cedar the researcher", thinkingLevel: "low" },
  })
  expect(renamed.ok()).toBe(true)
  await page.reload()
  await expect(
    page.getByRole("heading", { name: "Cedar the researcher", exact: true })
  ).toBeVisible()
  await expect(page.getByText("low", { exact: true })).toBeVisible()
  await page.goto("/agents")
  const row = page.getByRole("article").filter({
    has: page.locator(`a[href="/agents/${agent.slug}"]`),
  })
  // The directory is paginated and the isolated fixture database can be reused.
  for (
    let pageNumber = 0;
    pageNumber < 100 && !(await row.count());
    pageNumber++
  ) {
    const next = page.getByRole("button", { name: "Next page", exact: true })
    await expect(next).toBeVisible()
    await page.goto((await next.getAttribute("href"))!)
  }
  await expect(row.getByText("example-reasoner", { exact: true })).toBeVisible()
})
