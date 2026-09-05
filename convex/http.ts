import { stripeWebhook } from "./stripeHttp";
import { httpRouter } from "convex/server"
import { ConvexError } from "convex/values"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { authComponent, createAuth } from "./auth"
import { readApi } from "./lib/readApi"
import {
  readSchemas,
  keySchema,
  linkWorkosSchema,
  type ReadOperation,
} from "../lib/read-contracts"
import { fail } from "./lib/core"
import { digest } from "../lib/hash"
import { resolveAgentCredential } from "./lib/resolveAgentCredential"

const http = httpRouter()
authComponent.registerRoutes(http, createAuth)
const statuses: Record<string, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 400,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
}
const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Authorization, Content-Type, Idempotency-Key",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Expose-Headers": "ETag, Retry-After, WWW-Authenticate",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
}
const route = httpAction(async (ctx, request) => {
  if (request.method === "OPTIONS")
    return new Response(null, { status: 204, headers })
  try {
    const url = new URL(request.url)
    const path = url.pathname
      .replace(/^\/api\/v1\/?/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent)
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    let result: unknown
    let status = 200
    if (request.method === "GET") {
      let operation = path[0] ?? "resources"
      const input = Object.fromEntries(url.searchParams)
      if (path[1]) {
        const nested: Record<string, string> = {
          resources: "resource",
          agents: "agent",
          spaces: "space",
          tasks: "task",
          reports: "report",
        }
        operation = nested[operation] ?? operation
        input[operation === "agent" || operation === "space" ? "slug" : "id"] =
          path[1]
        if (path[0] === "resources" && path[2]) {
          operation = path[2]
          input.resourceId = path[1]
          delete input.id
        }
      }
      if (path[0] === "me")
        operation = path[1] ?? "work"
      if (!Object.hasOwn(readSchemas, operation))
        fail("NOT_FOUND", "Endpoint not found. See /openapi.json.")
      result = await readApi(ctx, operation as ReadOperation, input, token)
      if (result === null) fail("NOT_FOUND", "Record not found.")
      const userAgent = request.headers.get("user-agent") ?? ""
      const client = /OAI-SearchBot|ChatGPT-User/i.test(userAgent)
        ? "openai_retrieval"
        : /Claude-SearchBot|Claude-User/i.test(userAgent)
          ? "anthropic_retrieval"
          : /Googlebot/i.test(userAgent)
            ? "google"
            : /bingbot/i.test(userAgent)
              ? "bing"
              : "other"
      const referer = request.headers.get("referer") ?? ""
      const referral =
        /^https:\/\/(chatgpt\.com|www\.perplexity\.ai|claude\.ai)\//i.test(
          referer
        )
          ? "ai"
          : /^https:\/\/((www\.)?google\.[^/]+|www\.bing\.com)\//i.test(referer)
            ? "search"
            : "none"
      await ctx.scheduler.runAfter(0, internal.analytics.access, {
        operation,
        ...(token ? { tokenHash: digest(token) } : {}),
        client,
        referral,
      })
    } else if (request.method === "POST") {
      // Bound the streamed body as well as Content-Length; clients cannot bypass this with chunked encoding.
      const reader = request.body?.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      if (reader)
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 600_000) {
            await reader.cancel()
            fail(
              "VALIDATION",
              "Request exceeds 600 KB. Upload large logs using file storage."
            )
          }
          chunks.push(value)
        }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      let input: unknown
      try {
        input = JSON.parse(new TextDecoder().decode(bytes))
      } catch {
        fail("VALIDATION", "Request body must be JSON.")
      }
      if (path[0] === "agents" && path.length === 1) {
        if (token && !token.startsWith("an_")) {
          const identity = await ctx.runAction(internal.workos.authenticate, { token });
          result = await ctx.runMutation(internal.workosIdentity.provision, { identity, input });
        } else {
          result = await ctx.runAction(internal.registration.register, { input });
        }
        status = 201
      } else if (path[0] === "agents" && path[1] === "workos" && path.length === 2) {
        const parsed = linkWorkosSchema.safeParse(input);
        if (!parsed.success) fail("VALIDATION", "Supply the existing agent key.");
        const identity = await ctx.runAction(internal.workos.authenticate, { token });
        result = await ctx.runMutation(internal.workosIdentity.provision, { identity, existingKey: parsed.data.existingKey });
      } else if (path[0] === "keys") {
        const parsed = keySchema.safeParse(input)
        if (!parsed.success)
          fail("VALIDATION", "Provide a label and valid scopes.")
        result = await ctx.runAction(internal.registration.newKey, {
          token,
          ...parsed.data,
        })
        status = 201
      } else if (path[0] === "commands" && path[1]) {
        const idempotencyKey = request.headers.get("Idempotency-Key")
        result = await ctx.runMutation(internal.commands.execute, {
          token: await resolveAgentCredential(ctx, token),
          operation: path[1],
          input,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        })
      } else fail("NOT_FOUND", "Endpoint not found. See /openapi.json.")
    } else
      return Response.json(
        { error: { code: "METHOD_NOT_ALLOWED", message: "Use GET or POST." } },
        { status: 405, headers }
      )
    return Response.json({ data: result }, { status, headers })
  } catch (error) {
    let data: {
      code: string
      message: string
      details?: Record<string, string | number>
    } = {
      code: "INTERNAL",
      message: "The request failed. Retry with the same idempotency key.",
    }
    if (error instanceof ConvexError) {
      const raw =
        typeof error.data === "string"
          ? (() => {
              try {
                return JSON.parse(error.data)
              } catch {
                return null
              }
            })()
          : error.data
      if (raw && typeof raw === "object" && "code" in raw && "message" in raw)
        data = raw as typeof data
    }
    const retry = data.details?.retryAfterSeconds
    return Response.json(
      { error: data },
      {
        status: statuses[data.code] ?? 500,
        headers: {
          ...headers,
          ...(retry ? { "Retry-After": String(retry) } : {}),
          ...(data.code === "UNAUTHORIZED" && process.env.WORKOS_CLIENT_ID && process.env.SITE_URL ? { "WWW-Authenticate": `Bearer resource_metadata="${process.env.SITE_URL}/.well-known/oauth-protected-resource"` } : {}),
        },
      }
    )
  }
})
for (const method of ["GET", "POST", "OPTIONS"] as const)
  http.route({ pathPrefix: "/api/v1/", method, handler: route })
http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook });
export default http
