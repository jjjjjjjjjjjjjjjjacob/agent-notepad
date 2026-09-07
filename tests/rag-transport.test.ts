import { attempt } from "../lib/effects"
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"
import { forwardApiEffect } from "../lib/gateway"
import { POST } from "../app/mcp/route"
import { openapi } from "../lib/openapi"

vi.mock("server-only", () => ({}))
vi.mock("../lib/gateway", () => ({ forwardApiEffect: vi.fn() }))
vi.mock("../lib/embeddings", async () => {
  const { attempt } = await import("../lib/effects")
  const embed = vi.fn(),
    embedMany = vi.fn()
  return {
    embeddingsConfigured: () => false,
    embed,
    embedMany,
    embedEffect: (text: string) => attempt(() => embed(text)),
    embedManyEffect: (texts: string[], kind: string) =>
      attempt(() => embedMany(texts, kind)),
  }
})
const modules = import.meta.glob("../convex/**/*.ts")
const origin = "http://localhost:3843"

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv("NEXT_PUBLIC_SITE_URL", origin)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.clearAllMocks()
})

it("delivers the same one-call context through public REST and MCP, preserving query arrays", async () => {
  const t = convexTest(schema, modules)
  const token = "transport-test-key"
  await t.mutation(internal.agents.create, {
    input: { name: "Transport tester", slug: "transport-tester" },
    hash: digest(token),
    prefix: "test",
  })
  for (const [title, body] of [
    ["Capybara diet", "Capybaras eat grasses."],
    ["Onsen bathing", "Thermal bathing began in 1982."],
  ])
    await t.mutation(internal.commands.execute, {
      token,
      operation: "publish",
      input: {
        kind: "wiki",
        slug: title.toLowerCase().replaceAll(" ", "-"),
        title,
        body,
      },
    })
  vi.mocked(forwardApiEffect).mockImplementation((path, init) =>
    attempt(() => t.fetch(`/api/v1/${path}`, init))
  )
  const params = new URLSearchParams({
    query: "capybara diet",
    kind: "wiki",
    maxChars: "12000",
  })
  params.append("queries", "onsen bathing")
  params.append("queries", "thermal history")
  const rest = await t.fetch(`/api/v1/retrieve?${params}`)
  expect(rest.status).toBe(200)
  const restBody = await rest.json()
  expect(restBody.data.items).toHaveLength(2)

  const call = async (method: string, params: object = {}) => {
    const response = await POST(
      new Request(`${origin}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      })
    )
    expect(response.status).toBe(200)
    return response.json()
  }
  const tools = await call("tools/list")
  const retrieve = tools.result.tools.find(
    (tool: { name: string }) => tool.name === "get_retrieve"
  )
  expect(retrieve.annotations.readOnlyHint).toBe(true)
  expect(retrieve.description).toContain("maxChars")
  expect(retrieve.inputSchema.properties.queries.type).toBe("array")
  const mcp = await call("tools/call", {
    name: "get_retrieve",
    arguments: {
      query: "capybara diet",
      queries: ["onsen bathing", "thermal history"],
      kind: "wiki",
      maxChars: 12000,
    },
  })
  expect(mcp.result.isError).toBe(false)
  expect(mcp.result.structuredContent).toEqual(restBody)
  expect(forwardApiEffect).toHaveBeenCalledTimes(1)
  expect(
    new URLSearchParams(
      vi.mocked(forwardApiEffect).mock.calls[0][0].split("?")[1]
    ).getAll("queries")
  ).toEqual(["onsen bathing", "thermal history"])
  const invalid = await t.fetch("/api/v1/retrieve?query=test&maxChars=999999")
  expect(invalid.status).toBe(400)
})

it("advertises retrieval and its context controls in OpenAPI", () => {
  const document = openapi()
  const route = document.paths["/retrieve"] as {
    get: {
      operationId: string
      security?: unknown
      parameters: { name: string }[]
    }
  }
  expect(route.get.operationId).toBe("get_retrieve")
  expect(route.get.security).toBeUndefined()
  expect(route.get.parameters.map((p) => p.name)).toEqual(
    expect.arrayContaining(["queries", "maxChars", "passagesPerResource"])
  )
})

it.each(["timeout", "malformed", "invalid_shape", "unsafe_error", "defect"])(
  "returns an MCP tool failure for %s without exposing internals",
  async (mode) => {
    const { Effect } = await import("effect")
    const { appError } = await import("../lib/errors")
    vi.mocked(forwardApiEffect).mockImplementation(() =>
      mode === "timeout"
        ? Effect.fail(appError("TIMEOUT", "The backend timed out."))
        : mode === "defect"
          ? Effect.die(new Error("private transport detail"))
          : Effect.succeed(
              mode === "invalid_shape"
                ? Response.json(null)
                : mode === "unsafe_error"
                  ? Response.json(
                      { error: "private provider details" },
                      { status: 500 }
                    )
                  : new Response("private malformed content")
            )
    )
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const response = await POST(
        new Request(`${origin}/mcp`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 12,
            method: "tools/call",
            params: { name: "get_resources", arguments: {} },
          }),
        })
      )
      const result = await response.json()
      expect(result.result.isError).toBe(true)
      expect(result.result.structuredContent.error.code).toBe(
        mode === "timeout"
          ? "TIMEOUT"
          : mode === "defect"
            ? "INTERNAL"
            : "BAD_GATEWAY"
      )
      expect(JSON.stringify(result)).not.toMatch(/private|FiberFailure|stack/)
    } finally {
      log.mockRestore()
    }
  }
)
