/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"

const provider = vi.hoisted(() => ({
  constructed: vi.fn(),
  validate: vi.fn(),
  registration: vi.fn(),
  user: vi.fn(),
}))
vi.mock("@workos-inc/node", () => ({
  WorkOS: class {
    constructor() { provider.constructed() }
    agents = { validateCredential: provider.validate, getRegistration: provider.registration }
    userManagement = { getUser: provider.user }
  },
}))
const modules = import.meta.glob("../convex/**/*.ts")
function setup() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
let sequence = 0
const token = (n = 0) => `fixture.rotating${n}.credential`
const authenticate = (t: Test, n = 0) => t.action(internal.workos.authenticate, { token: token(n) })
const http = (t: Test, n = 0, path = "me/billing") => t.fetch(`/api/v1/${path}`, {
  headers: { Authorization: `Bearer ${token(n)}` },
})

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  // Different synthetic configuration for each test isolates the module cache.
  vi.stubEnv("WORKOS_API_KEY", `fixture-only-${++sequence}`)
  vi.stubEnv("WORKOS_CLIENT_ID", "client_test")
  vi.stubEnv("WORKOS_AUTHKIT_ISSUER", "https://test.authkit.app")
  vi.stubEnv("WORKOS_AGENT_AUDIENCE", "client_test")
  vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "20")
  vi.stubEnv("MODERATION_ENABLED", "false")
  provider.validate.mockResolvedValue({ valid: false, claims: null })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs() })

function valid() {
  const registration = {
    id: "agent_reg_security", organizationId: "org_test", status: "unverified",
    agentIdentity: { userlandUserId: null },
  }
  provider.validate.mockResolvedValue({
    valid: true, registrationId: registration.id,
    claims: {
      issuer: "https://test.authkit.app", audience: "client_test",
      registrationId: registration.id, organizationId: "org_test",
      expiresAt: Date.now() / 1000 + 3600, issuedAt: Date.now() / 1000,
      scope: "profile:write social:write",
    },
  })
  provider.registration.mockResolvedValue(registration)
  return registration
}

describe("WorkOS shared authentication cost controls", () => {
  it("reuses the SDK for rejected tokens and invalidates it for every authority setting", async () => {
    const t = setup()
    await expect(authenticate(t, 1)).rejects.toThrow("UNAUTHORIZED")
    await expect(authenticate(t, 2)).rejects.toThrow("UNAUTHORIZED")
    expect(provider.constructed).toHaveBeenCalledTimes(1)
    let expected = 1
    for (const [key, value] of [
      ["WORKOS_API_KEY", "different-fixture-only"],
      ["WORKOS_CLIENT_ID", "client_other"],
      ["WORKOS_AUTHKIT_ISSUER", "https://other.authkit.app"],
      ["WORKOS_AGENT_AUDIENCE", "resource_other"],
    ]) {
      vi.stubEnv(key, value)
      await expect(authenticate(t)).rejects.toThrow("UNAUTHORIZED")
      expect(provider.constructed).toHaveBeenCalledTimes(++expected)
    }
    vi.stubEnv("WORKOS_API_KEY", "")
    await expect(authenticate(t)).rejects.toThrow("NOT_CONFIGURED")
    expect(provider.constructed).toHaveBeenCalledTimes(expected)
  })

  it("shares a durable finite budget between direct action and HTTP, despite rotating rejected tokens", async () => {
    vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "2")
    const t = setup()
    await expect(authenticate(t, 1)).rejects.toThrow("UNAUTHORIZED")
    expect((await http(t, 2)).status).toBe(401)
    const denied = await http(t, 3)
    expect(denied.status).toBe(429)
    expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0)
    await expect(authenticate(t, 4)).rejects.toThrow("RATE_LIMITED")
    expect(provider.validate).toHaveBeenCalledTimes(2)
    const buckets = await t.run(ctx => ctx.db.query("limits").collect())
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(2)
    vi.setSystemTime(Date.now() + 60_000)
    await expect(authenticate(t, 5)).rejects.toThrow("UNAUTHORIZED")
    expect(provider.validate).toHaveBeenCalledTimes(3)
    expect(await t.run(ctx => ctx.db.query("limits").collect())).toHaveLength(1)
  })

  it("admits at most the aggregate cap when attempts arrive concurrently", async () => {
    vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "3")
    const t = setup()
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, n) => authenticate(t, n)))
    expect(results.every(result => result.status === "rejected")).toBe(true)
    expect(provider.validate).toHaveBeenCalledTimes(3)
    expect(provider.constructed).toHaveBeenCalledTimes(1)
    const buckets = await t.run(ctx => ctx.db.query("limits").collect())
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(3)
  })

  it("keeps the shared budget when worker client configuration is replaced", async () => {
    vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "2")
    const t = setup()
    await expect(authenticate(t, 1)).rejects.toThrow("UNAUTHORIZED")
    vi.stubEnv("WORKOS_CLIENT_ID", "replacement-client")
    await expect(authenticate(t, 2)).rejects.toThrow("UNAUTHORIZED")
    vi.stubEnv("WORKOS_CLIENT_ID", "another-replacement")
    await expect(authenticate(t, 3)).rejects.toThrow("RATE_LIMITED")
    expect(provider.constructed).toHaveBeenCalledTimes(2)
    expect(provider.validate).toHaveBeenCalledTimes(2)
    const buckets = await t.run(ctx => ctx.db.query("limits").collect())
    expect(buckets).toHaveLength(1)
    expect(buckets[0].count).toBe(2)
  })

  it("applies the documented default and maximum configuration caps", async () => {
    for (const [setting, maximum] of [[undefined, 1200], ["10000", 10_000]] as const) {
      vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", setting)
      const t = setup()
      await t.run(ctx => ctx.db.insert("limits", {
        bucket: "workos:authentication", count: maximum - 1, resetAt: Date.now() + 60_000,
      }))
      await expect(authenticate(t)).rejects.toThrow("UNAUTHORIZED")
      await expect(authenticate(t)).rejects.toThrow("RATE_LIMITED")
      expect((await t.run(ctx => ctx.db.query("limits").unique()))?.count).toBe(maximum)
    }
    expect(provider.validate).toHaveBeenCalledTimes(2)
  })

  it("does not cache successful authorization when the global allowance is exhausted", async () => {
    vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "2")
    const t = setup()
    valid()
    await authenticate(t)
    await authenticate(t)
    await expect(authenticate(t)).rejects.toThrow("RATE_LIMITED")
    expect(provider.validate).toHaveBeenCalledTimes(2)
    expect(provider.registration).toHaveBeenCalledTimes(2)
  })

  it("rejects malformed credentials locally without consuming the external-work budget", async () => {
    const t = setup()
    for (const bad of ["", "not-a-jwt", "one.two", "a.b." + "x".repeat(16_384)]) {
      await expect(t.action(internal.workos.authenticate, { token: bad })).rejects.toThrow("UNAUTHORIZED")
    }
    expect(provider.validate).not.toHaveBeenCalled()
    expect(await t.run(ctx => ctx.db.query("limits").collect())).toHaveLength(0)
  })

  it("rejects unsafe budget configuration before calling the provider", async () => {
    const t = setup()
    for (const cap of ["", "0", "-1", "1.5", "NaN", "Infinity", "10001"]) {
      vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", cap)
      await expect(authenticate(t)).rejects.toThrow("NOT_CONFIGURED")
    }
    expect(provider.validate).not.toHaveBeenCalled()
    expect(await t.run(ctx => ctx.db.query("limits").collect())).toHaveLength(0)
  })

  it("revalidates successful credentials and current registration on every request", async () => {
    const t = setup(), registration = valid()
    await authenticate(t)
    await authenticate(t)
    expect(provider.constructed).toHaveBeenCalledTimes(1)
    expect(provider.validate).toHaveBeenCalledTimes(2)
    expect(provider.registration).toHaveBeenCalledTimes(2)
    expect(provider.validate).toHaveBeenLastCalledWith({ type: "access_token", credential: token(), audience: "client_test", checkForRevoked: true })
    registration.status = "revoked"
    await expect(authenticate(t)).rejects.toThrow("UNAUTHORIZED")
    expect(provider.registration).toHaveBeenCalledTimes(3)
  })

  it("counts provider errors without leaking their details and leaves legacy/public reads available", async () => {
    vi.stubEnv("WORKOS_AUTH_MAX_ATTEMPTS_PER_MINUTE", "1")
    const t = setup()
    provider.validate.mockRejectedValue(new Error("sensitive-provider-detail"))
    const failed = await http(t)
    expect(failed.status).toBe(401)
    expect(await failed.text()).not.toContain("sensitive-provider-detail")
    expect((await http(t, 1)).status).toBe(429)
    expect((await t.fetch("/api/v1/resources")).status).toBe(200)
    const registered = await t.fetch("/api/v1/agents", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Legacy security fixture", slug: "legacy-security-fixture" }),
    })
    expect(registered.status).toBe(201)
    const key = (await registered.json()).data.apiKey
    expect((await t.fetch("/api/v1/me/billing", { headers: { Authorization: `Bearer ${key}` } })).status).toBe(200)
    expect(provider.validate).toHaveBeenCalledTimes(1)
  })
})
