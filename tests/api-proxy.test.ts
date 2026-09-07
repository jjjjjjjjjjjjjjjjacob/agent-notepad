import { createServer, type Server } from "node:http"
import { gzipSync } from "node:zlib"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import { GET, POST } from "../app/api/v1/[[...path]]/route"

const article = {
  data: {
    title: "Capybaras in Japan",
    body: "カピバラ enjoy the water. ".repeat(100),
  },
}
const compressed = gzipSync(JSON.stringify(article))
let backend: Server
let proxy: Server
let origin: string

async function listen(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("No test port")
  return `http://127.0.0.1:${address.port}`
}

beforeAll(async () => {
  backend = createServer(async (request, response) => {
    for await (const chunk of request) void chunk
    response.writeHead(request.method === "POST" ? 201 : 200, {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",
      "Content-Length": compressed.byteLength,
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    })
    response.end(compressed)
  })
  vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", await listen(backend))

  proxy = createServer(async (request, response) => {
    try {
      const incoming = new Request(`${origin}${request.url}`, {
        method: request.method,
        ...(request.method === "POST"
          ? {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ kind: "wiki", title: article.data.title }),
            }
          : {}),
      })
      const forwarded = await (request.method === "POST" ? POST : GET)(incoming)
      response.writeHead(
        forwarded.status,
        Object.fromEntries(forwarded.headers)
      )
      response.end(Buffer.from(await forwarded.arrayBuffer()))
    } catch (error) {
      response.destroy(error instanceof Error ? error : undefined)
    }
  })
  origin = await listen(proxy)
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await Promise.all(
    [proxy, backend].filter(Boolean).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        })
    )
  )
})

describe("API proxy with compressed upstream responses", () => {
  it.each(["GET", "POST"])(
    "delivers complete, readable JSON for %s",
    async (method) => {
      const response = await fetch(
        `${origin}/api/v1/resources/capybaras-in-japan`,
        { method }
      )
      expect(response.status).toBe(method === "POST" ? 201 : 200)
      expect(await response.json()).toEqual(article)
      expect(response.headers.get("content-type")).toBe("application/json")
      expect(response.headers.get("cache-control")).toBe("no-store")
      expect(response.headers.get("access-control-allow-origin")).toBe("*")
    }
  )
})

it.each([
  [new DOMException("private upstream detail", "TimeoutError"), 504, "TIMEOUT"],
  [new TypeError("private connection detail"), 503, "UNAVAILABLE"],
] as const)(
  "normalizes gateway transport failures to %s",
  async (failure, status, code) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(failure)
    try {
      const response = await GET(
        new Request("http://localhost/api/v1/resources")
      )
      expect(response.status).toBe(status)
      expect(await response.json()).toMatchObject({ error: { code } })
      expect(response.headers.get("Cache-Control")).toBe("no-store")
    } finally {
      fetch.mockRestore()
    }
  }
)
it("rejects a malformed URL path with a validation response", async () => {
  const response = await GET(new Request("http://localhost/api/v1/%FF"))
  expect(response.status).toBe(400)
  expect((await response.json()).error.code).toBe("VALIDATION")
})
