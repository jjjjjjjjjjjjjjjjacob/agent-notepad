import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setupStripe } from "../scripts/setup-stripe"
import { STRIPE_API_VERSION, STRIPE_EVENTS } from "../lib/stripe-config"
const provider = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}))
vi.mock("stripe", async (original) => {
  const actual = await original<typeof import("stripe")>()
  return {
    default: class extends actual.default {
      constructor(...args: ConstructorParameters<typeof actual.default>) {
        super(...args)
        this.webhookEndpoints.list = provider.list
        this.webhookEndpoints.create = provider.create
        this.webhookEndpoints.update = provider.update
      }
    },
  }
})
let directory: string
const root = process.cwd()
beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), "notepad-stripe-setup-"))
  process.chdir(directory)
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_setup_fixture")
  vi.stubEnv("STRIPE_WEBHOOK_SECRET", "")
  vi.stubEnv("STRIPE_AGENT_PROFILE_ID", "profile_fixture")
  vi.stubEnv("SITE_URL", "https://frontend.example")
  vi.stubEnv("STRIPE_WEBHOOK_URL", "https://backend.example/stripe/webhook")
  provider.list.mockImplementation(async function* () {})
  provider.create.mockResolvedValue({
    id: "we_fixture",
    secret: "whsec_fixture",
  })
  vi.spyOn(console, "log").mockImplementation(() => {})
})
afterEach(async () => {
  process.chdir(root)
  await rm(directory, { recursive: true, force: true })
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})
it("preflights without writes and refuses an implicit deployment target", async () => {
  await setupStripe(["--check"])
  expect(provider.create).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
  await expect(setupStripe(["--apply"])).rejects.toThrow(
    "explicit --deployment"
  )
  vi.stubEnv("SITE_URL", "")
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", "")
  await expect(setupStripe(["--check"])).rejects.toThrow("Set SITE_URL")
  vi.stubEnv("SITE_URL", "https://frontend.example")
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "")
  vi.stubEnv("STRIPE_WEBHOOK_URL", "")
  await expect(setupStripe(["--check"])).rejects.toThrow(
    "Set NEXT_PUBLIC_CONVEX_SITE_URL"
  )
})
it("provisions a pinned webhook and keeps generated secrets private", async () => {
  await setupStripe([])
  expect(provider.create).toHaveBeenCalledWith(
    expect.objectContaining({
      url: "https://backend.example/stripe/webhook",
      api_version: STRIPE_API_VERSION,
      enabled_events: [...STRIPE_EVENTS],
    }),
    expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^an-webhook:/),
    })
  )
  const files = await readdir(join(directory, ".artifacts/stripe"))
  const file = join(
    directory,
    ".artifacts/stripe",
    files.find((f) => f.endsWith(".env"))!
  )
  expect((await stat(file)).mode & 0o777).toBe(0o600)
  expect(await readFile(file, "utf8")).toContain(
    'STRIPE_WEBHOOK_SECRET="whsec_fixture"'
  )
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    "whsec_fixture"
  )
  expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(
    "sk_test_setup_fixture"
  )
  provider.list.mockImplementation(async function* () {
    yield {
      id: "we_fixture",
      url: "https://backend.example/stripe/webhook",
      enabled_events: ["entitlements.active_entitlement_summary.updated"],
    }
  })
  await setupStripe([])
  expect(provider.create).toHaveBeenCalledTimes(1)
  expect(provider.update).toHaveBeenCalledWith(
    "we_fixture",
    expect.objectContaining({
      enabled_events: expect.arrayContaining([
        "entitlements.active_entitlement_summary.updated",
        "invoice.paid",
      ]),
      disabled: false,
    })
  )
})
it("requires the existing signing secret and rejects credential-bearing URLs", async () => {
  provider.list.mockImplementation(async function* () {
    yield {
      id: "we_existing",
      url: "https://backend.example/stripe/webhook",
      enabled_events: [],
    }
  })
  await expect(setupStripe([])).rejects.toThrow(
    "signing secrets cannot be read"
  )
  expect(provider.update).not.toHaveBeenCalled()
  vi.stubEnv(
    "STRIPE_WEBHOOK_URL",
    "https://user:password@backend.example/stripe/webhook"
  )
  await expect(setupStripe([])).rejects.toThrow("webhook URL")
  expect(provider.create).not.toHaveBeenCalled()
})
