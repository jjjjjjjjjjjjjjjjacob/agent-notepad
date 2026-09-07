/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"
import { deliverEvent } from "../lib/analytics/delivery"

vi.mock("../lib/analytics/delivery", async () => {
  const { external } = await import("../lib/effects")
  const deliverEvent = vi.fn().mockResolvedValue(undefined)
  return {
    deliverEvent,
    deliverEventEffect: (input: unknown) =>
      external(() => deliverEvent(input), "Analytics delivery"),
  }
})
const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest(schema, modules)
beforeEach(() => {
  vi.useFakeTimers()
  vi.mocked(deliverEvent).mockReset().mockResolvedValue(undefined)
  vi.stubEnv("APP_ENV", "test")
  vi.stubEnv("POSTHOG_ENABLED", "true")
  vi.stubEnv("POSTHOG_VERIFICATION", "true")
  vi.stubEnv("POSTHOG_PROJECT_TOKEN", "phc_verification_only_token")
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
const deliveries = (event: string) =>
  vi
    .mocked(deliverEvent)
    .mock.calls.map(([arg]) => arg)
    .filter((arg) => arg.event === event)

it("counts each committed contribution once across retries and never sends body or credentials", async () => {
  const t = setup()
  const token = "an_private_credential"
  const agent = await t.mutation(internal.agents.create, {
    input: {},
    hash: digest(token),
    prefix: "test",
  })
  const command = {
    token,
    operation: "publish",
    idempotencyKey: "private-retry-key",
    input: { kind: "note", title: "Private title", body: "Private body" },
  }
  const first = await t.mutation(internal.commands.execute, command)
  expect(await t.mutation(internal.commands.execute, command)).toEqual(first)
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(deliveries("agent_registered")).toHaveLength(1)
  expect(deliveries("agent_command_completed")).toHaveLength(1)
  expect(deliveries("agent_command_completed")[0].distinctId).toBe(
    `agent:${agent.agentId}`
  )
  expect(JSON.stringify(deliveries("agent_command_completed"))).not.toMatch(
    /Private|credential|retry-key/
  )
})
it("records failed requests and separates REST/MCP without accepting a caller's analytics identity", async () => {
  const t = setup()
  const token = "an_private_credential"
  const agent = await t.mutation(internal.agents.create, {
    input: {},
    hash: digest(token),
    prefix: "test",
  })
  await t.fetch("/api/v1/resources", {
    headers: {
      Authorization: `Bearer ${token}`,
      "x-agent-notepad-transport": "mcp",
      "x-posthog-distinct-id": "human:spoofed",
    },
  })
  const response = await t.fetch("/api/v1/unknown?query=private-search")
  expect(response.status).toBe(404)
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  const events = deliveries("agent_api_request")
  expect(events).toHaveLength(2)
  expect(events.find((e) => e.properties.transport === "mcp")).toMatchObject({
    distinctId: `agent:${agent.agentId}`,
    properties: { operation: "resources", status: 200 },
  })
  expect(
    events.find((e) => e.properties.status === 404)?.properties.actor_type
  ).toBe("anonymous_api")
  expect(JSON.stringify(events)).not.toMatch(
    /spoofed|private-search|credential/
  )
})
it("uses the same verified WorkOS agent identity for registration and later requests", async () => {
  const t = setup()
  const identity = {
    registrationId: "registration_test",
    scopes: ["profile:write"],
    expiresAt: Date.now() + 3600_000,
  }
  const agent = await t.mutation(internal.workosIdentity.provision, {
    identity,
    input: {},
  })
  await t.mutation(internal.workosIdentity.provision, { identity, input: {} })
  await t.mutation(internal.analytics.request, {
    principal: identity,
    transport: "mcp",
    properties: { operation: "billing", status: 200, duration_ms: 20 },
  })
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(deliveries("agent_registered")).toHaveLength(1)
  expect(deliveries("agent_api_request")[0].distinctId).toBe(
    `agent:${agent!.agentId}`
  )
})
it("retries delivery with a stable UUID and stops after three failures", async () => {
  const t = setup()
  vi.mocked(deliverEvent).mockRejectedValue(
    Object.assign(new Error("Private provider failure"), { status: 503 })
  )
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
  await t.mutation(internal.agents.create, {
    input: {},
    hash: digest("token"),
    prefix: "test",
  })
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(deliveries("agent_registered")).toHaveLength(3)
  expect(new Set(deliveries("agent_registered").map((e) => e.uuid)).size).toBe(
    1
  )
  expect(warn).toHaveBeenCalledWith("analytics_delivery_failed")
  warn.mockRestore()
})

it("does not bypass browser consent at the REST boundary", async () => {
  const t = setup()
  expect(
    (
      await t.fetch("/api/v1/resources", {
        headers: { "sec-fetch-site": "same-origin" },
      })
    ).status
  ).toBe(200)
  await t.finishAllScheduledFunctions(() => vi.runAllTimers())
  expect(deliveries("agent_api_request")).toEqual([])
})
