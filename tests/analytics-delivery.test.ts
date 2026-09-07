import { afterEach, expect, it, vi } from "vitest"
import { gunzipSync } from "node:zlib"
import { deliverEvent } from "../lib/analytics/delivery"
import { PostHog } from "posthog-node"

const environment = {
  APP_ENV: "test",
  POSTHOG_ENABLED: "true",
  POSTHOG_VERIFICATION: "true",
  POSTHOG_PROJECT_TOKEN: "phc_verification_only_token",
}
const fixture = () => {
  const uuid = crypto.randomUUID()
  return {
    event: "agent_document_read",
    properties: {
      environment: "verification",
      actor_type: "anonymous_api",
      transport: "rest",
      document: "agent-guide",
      secret: "must-not-leave",
    },
    distinctId: `anonymous_api:${uuid}`,
    uuid,
    timestamp: Date.now(),
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it("awaits real Node SDK ingestion and preserves the event UUID through its wire format", async () => {
  const bodies: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer())
      bodies.push(
        bytes[0] === 31 ? gunzipSync(bytes).toString() : bytes.toString()
      )
      return new Response(JSON.stringify({ status: 1 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    })
  )
  const event = fixture()
  await deliverEvent(event, environment)
  expect(bodies).toHaveLength(1)
  expect(bodies[0]).toContain(event.uuid)
  expect(bodies[0]).toContain("agent_document_read")
  expect(bodies[0]).not.toContain("must-not-leave")
})

it("surfaces an ingestion failure to the bounded scheduler instead of reporting success", async () => {
  const fetch = vi.fn(async () => new Response("unavailable", { status: 503 }))
  vi.stubGlobal("fetch", fetch)
  await expect(deliverEvent(fixture(), environment)).rejects.toMatchObject({
    code: "UNAVAILABLE",
  })
  expect(fetch).toHaveBeenCalledOnce()
})

it.each([200, 503])(
  "preserves the flush outcome when shutdown fails after HTTP %s",
  async (status) => {
    const fetch = vi.fn(async () => new Response("{}", { status }))
    vi.stubGlobal("fetch", fetch)
    vi.spyOn(PostHog.prototype, "shutdown").mockRejectedValue(
      Object.assign(new Error("private shutdown detail"), {
        name: "PostHogFetchNetworkError",
      })
    )
    const result = deliverEvent(fixture(), environment)
    if (status === 200) await expect(result).resolves.toBeUndefined()
    else await expect(result).rejects.toMatchObject({ code: "UNAVAILABLE" })
    expect(fetch).toHaveBeenCalledOnce()
  }
)

it("propagates an unexpected shutdown defect without exposing its text", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("{}"))
  )
  vi.spyOn(PostHog.prototype, "shutdown").mockRejectedValue(
    new Error("private shutdown defect")
  )
  await expect(deliverEvent(fixture(), environment)).rejects.toThrow(
    "Unexpected operation failure."
  )
})
