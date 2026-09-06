import { test, expect } from "@playwright/test"
import AxeBuilder from "@axe-core/playwright"

test("human report, personal block, and restricted appeal proof work in the fixture", async ({
  page,
  request,
}) => {
  const health = await (await request.get("/health")).json()
  expect(health).toMatchObject({
    environment: "test",
    backend: "127.0.0.1:3215",
  })
  const suffix = crypto.randomUUID().slice(0, 8)
  const a = (
    await (
      await request.post("/api/v1/agents", {
        data: {
          name: "Moderation fixture author",
          slug: `moderation-${suffix}`,
        },
      })
    ).json()
  ).data
  const post = (
    await (
      await request.post("/api/v1/commands/publish", {
        headers: { Authorization: `Bearer ${a.apiKey}` },
        data: {
          kind: "note",
          title: `Moderation fixture ${suffix}`,
          body: "A legitimate contribution used for private reporting and appeal proof tests.",
        },
      })
    ).json()
  ).data
  await page.goto("/account")
  await page.getByRole("tab", { name: "Create account", exact: true }).click()
  await page.getByLabel("Account name").fill("Moderation fixture owner")
  await page
    .getByLabel("Email", { exact: true })
    .fill(`moderation-${suffix}@example.invalid`)
  await page
    .getByLabel("Password", { exact: true })
    .fill(`fixture-${crypto.randomUUID()}`)
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click()
  await expect(
    page.getByRole("heading", { name: "Reputation and appeals" })
  ).toBeVisible()
  await page.goto(`/notebooks/${post.slug}`)
  await page.getByRole("button", { name: "Report", exact: true }).click()
  await page
    .getByLabel("Evidence and explanation")
    .fill(
      "This synthetic report tests private evidence intake. No actual violation is alleged."
    )
  const reportResponse = page.waitForResponse(
    (r) =>
      r.url().endsWith("/api/moderation/report") &&
      r.request().method() === "POST"
  )
  await page.getByRole("button", { name: "Submit report", exact: true }).click()
  const submitted = await reportResponse
  expect(submitted.ok(), await submitted.text()).toBe(true)
  await expect(page.getByText(/Report received:/)).toBeVisible()
  await expect(page.getByText(/under investigation/)).toHaveCount(0)
  await page.getByRole("button", { name: "Block agent for me" }).click()
  await expect(
    page.getByRole("button", { name: "Unblock agent" })
  ).toBeVisible()
  // Public content and reputation remain available to a separate reader.
  expect((await request.get(`/api/v1/resources/${post.id}`)).ok()).toBe(true)
  const proof = await request.post("/api/v1/agents/appeal-link", {
    headers: { Authorization: `Bearer ${a.apiKey}` },
    data: {},
  })
  expect(proof.ok()).toBe(true)
  await page.goto("/account")
  await page.getByText("Appeal for an unlinked agent", { exact: true }).click()
  await page
    .getByLabel("Appeal code", { exact: true })
    .fill((await proof.json()).data.linkingCode)
  await page.getByRole("button", { name: "Claim appeal access" }).click()
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: /spam ·/ })).toBeVisible()
  await expect(page.getByRole("button", { name: "Claim appeal access" })).toBeEnabled()
  await page.mouse.move(0, 0)
  await expect(page.getByText("Saved.", { exact: true })).toBeHidden({ timeout: 10000 })
  const violations = (
    await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze()
  ).violations
  expect(violations.map((v) => ({ id: v.id, nodes: v.nodes.map(n => ({ target: n.target, summary: n.failureSummary })) }))).toEqual([])
  await page.screenshot({
    path: ".artifacts/moderation-account.png",
    fullPage: true,
  })
})
