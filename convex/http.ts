import { webhook as placeWebhook } from "./placeHttp"
import { stripeWebhook } from "./stripeHttp"
import { httpRouter } from "convex/server"
import { ConvexError } from "convex/values"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { authComponent, createAuth } from "./auth"
import { isOperationEnabled } from "../lib/features"
import { readApi } from "./lib/readApi"
import {
  readSchemas,
  keySchema,
  linkWorkosSchema,
  type ReadOperation,
} from "../lib/read-contracts"
import { fail } from "./lib/core"
import { digest } from "../lib/hash"
import { GATEWAY_HEADER, verifyGateway } from "../lib/gateway-security"
import { commandSchemas, registrationSchema, type Operation } from "../lib/contracts"
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
    if (!isOperationEnabled((path[0] === "commands" ? path[1] : path[0]) ?? ""))
      fail("NOT_FOUND", "Place is not enabled.")
    const token =
      request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
    let result: unknown
    let status = 200
    if (request.method === "GET" && path[0] === "files" && path[1]) {
      const file = await ctx.runQuery(internal.moderationFileRecords.download, { id: path[1] })
      if (!file) fail("NOT_FOUND", "File unavailable or pending review.")
      const blob = await ctx.storage.get(file.storageId)
      if (!blob) fail("NOT_FOUND", "File unavailable.")
      return new Response(blob, { headers: { ...headers, "Content-Type": file.contentType, "Content-Disposition": "attachment", "Content-Security-Policy": "default-src 'none'; sandbox" } })
    }
    if (request.method === "GET") {
      let operation = path[0] ?? "resources"
      const input: Record<string, string | string[]> = Object.fromEntries(
        url.searchParams
      )
      if (url.searchParams.has("queries"))
        input.queries = url.searchParams.getAll("queries")
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
      if (path[0] === "me") operation = path[1] ?? "work"
      if (!Object.hasOwn(readSchemas, operation))
        fail("NOT_FOUND", "Endpoint not found. See /openapi.json.")
      result = await readApi(ctx, operation as ReadOperation, input, token)
      if (result === null) fail("NOT_FOUND", "Record not found.")
      if (token && ["resources", "comments", "changes", "notifications"].includes(operation)) result = await ctx.runQuery(internal.moderationReads.filterResult, { token: await resolveAgentCredential(ctx, token), result })
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
      const bodyText = new TextDecoder().decode(bytes)
      let ipHash: string | undefined
      if (process.env.MODERATION_ENABLED === "true" || request.headers.has(GATEWAY_HEADER)) {
        const secret = process.env.MODERATION_GATEWAY_SECRET
        if (!secret) fail("NOT_CONFIGURED", "Secure write gateway is not configured.")
        let envelope: unknown
        try { envelope = JSON.parse(request.headers.get(GATEWAY_HEADER) ?? "null") } catch { fail("FORBIDDEN", "Invalid gateway signature.") }
        const verified = verifyGateway(secret, envelope, { method: request.method, path: `${url.pathname}${url.search}`, body: bodyText, authorization: request.headers.get("authorization") ?? "" })
        if (!verified) fail("FORBIDDEN", "Use the public REST or MCP gateway for writes.")
        const gate = await ctx.runMutation(internal.governance.networkGate, { nonce: verified.nonce, ipHash: verified.ipHash, appeal: path[0] === "agents" && path[1] === "appeal-link", report: path[0] === "commands" && path[1] === "report_abuse" })
        if (gate.error) fail(gate.error === "RATE_LIMITED" ? "RATE_LIMITED" : "FORBIDDEN", "This request cannot contribute. Human appeals remain available through Account.")
        ipHash = verified.ipHash
      }
      let input: unknown
      try {
        input = JSON.parse(bodyText)
      } catch {
        fail("VALIDATION", "Request body must be JSON.")
      }
      if (path[0] === "agents" && path.length === 1) {
        const parsed = registrationSchema.safeParse(input)
        if (!parsed.success) fail("VALIDATION", "Supply a valid agent profile.")
        input = parsed.data
        let scan
        try { scan = await ctx.runAction(internal.screening.submission, { operation: "register", input, ...(ipHash ? { ipHash } : {}) }) } catch { fail("NOT_CONFIGURED", "Content screening is temporarily unavailable; retry later.") }
        if (scan.blocked) fail("FORBIDDEN", "This profile was withheld for prompt-injection review.")
        if (token && !token.startsWith("an_")) {
          const identity = await ctx.runAction(internal.workos.authenticate, {
            token,
          })
          result = await ctx.runMutation(internal.workosIdentity.provision, {
            identity,
            input,
          })
        } else {
          result = await ctx.runAction(internal.registration.register, {
            input,
          })
        }
        if (ipHash && result && typeof result === "object" && "agentId" in result) await ctx.runMutation(internal.governance.recordNetwork, { ipHash, agentId: result.agentId as import("./_generated/dataModel").Id<"agents">, targetId: result.agentId as string })
        status = 201
      } else if (
        path[0] === "agents" &&
        path[1] === "workos" &&
        path.length === 2
      ) {
        const parsed = linkWorkosSchema.safeParse(input)
        if (!parsed.success)
          fail("VALIDATION", "Supply the existing agent key.")
        const identity = await ctx.runAction(internal.workos.authenticate, {
          token,
        })
        result = await ctx.runMutation(internal.workosIdentity.provision, {
          identity,
          existingKey: parsed.data.existingKey,
        })
      } else if (
        path[0] === "agents" &&
        path[1] === "link" &&
        path.length === 2
      ) {
        if (
          !input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).length
        )
          fail(
            "VALIDATION",
            "Send an empty JSON object to request a linking code."
          )
        result = await ctx.runAction(internal.registration.createLink, {
          token,
        })
        status = 201
      } else if (path[0] === "agents" && path[1] === "appeal-link" && path.length === 2) {
        result = await ctx.runAction(internal.registration.appealLink, { token })
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
        if (!Object.hasOwn(commandSchemas, path[1])) fail("VALIDATION", "Unknown operation.")
        const parsed = commandSchemas[path[1] as Operation].safeParse(input)
        if (!parsed.success) fail("VALIDATION", "Invalid command input.")
        input = parsed.data
        const credential = await resolveAgentCredential(ctx, token)
        let scan
        try { scan = await ctx.runAction(internal.screening.submission, { token: credential, operation: path[1], input, ...(ipHash ? { ipHash } : {}) }) } catch (error) {
          if (error instanceof ConvexError) throw error
          fail("NOT_CONFIGURED", "Content screening is temporarily unavailable; retry later.")
        }
        if (scan.blocked) fail("FORBIDDEN", "Submission quarantined for prompt-injection review.", { caseId: scan.caseId ?? "" })
        result = await ctx.runMutation(internal.commands.execute, {
          token: credential,
          screeningFingerprint: scan.fingerprint,
          ...(scan.quarantine && scan.caseId ? { quarantineCaseId: scan.caseId as import("./_generated/dataModel").Id<"moderationCases"> } : {}),
          ...(ipHash ? { ipHash } : {}),
          operation: path[1],
          input,
          ...(idempotencyKey ? { idempotencyKey } : {}),
        })
        if (scan.caseId && result && typeof result === "object") await ctx.runMutation(internal.screeningResults.attachResult, { caseId: scan.caseId as import("./_generated/dataModel").Id<"moderationCases">, result })
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
          ...(data.code === "UNAUTHORIZED" &&
          process.env.WORKOS_CLIENT_ID &&
          process.env.SITE_URL
            ? {
                "WWW-Authenticate": `Bearer resource_metadata="${process.env.SITE_URL}/.well-known/oauth-protected-resource"`,
              }
            : {}),
        },
      }
    )
  }
})
for (const method of ["GET", "POST", "OPTIONS"] as const)
  http.route({ pathPrefix: "/api/v1/", method, handler: route })
http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook })
http.route({ path: "/place/sandbox/webhook", method: "POST", handler: placeWebhook })
export default http
