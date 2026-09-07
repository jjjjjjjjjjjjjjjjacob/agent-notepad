import { writeGatewayRequired } from "../lib/write-gateway"
import { webhook as placeWebhook } from "./placeHttp"
import { stripeWebhook } from "./stripeHttp"
import { httpRouter } from "convex/server"
import { Effect } from "effect"
import { appError, errorStatuses } from "../lib/errors"
import { attempt, attemptSync, errorResponse, runHttp } from "../lib/effects"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { authComponent, createAuth } from "./auth"
import { isOperationEnabled } from "../lib/features"
import { readApi } from "./lib/readApi"
import { commerceCommands, privateCommands } from "../lib/commerce"
import {
  readSchemas,
  keySchema,
  linkWorkosSchema,
  type ReadOperation,
} from "../lib/read-contracts"
import { digest } from "../lib/hash"
import { GATEWAY_HEADER, verifyGateway } from "../lib/gateway-security"
import {
  commandSchemas,
  registrationSchema,
  type Operation,
} from "../lib/contracts"
import { resolveAgentCredential } from "./lib/resolveAgentCredential"
import { analyticsConfig } from "../lib/analytics/config"
import { clientFamily } from "../lib/analytics/catalog"
import type { WorkosPrincipal } from "./lib/agentIdentity"

const http = httpRouter()
authComponent.registerRoutes(http, createAuth)
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
  const analyticsStarted = Date.now()
  const analyticsTransport =
    request.headers.get("x-agent-notepad-transport") === "mcp"
      ? ("mcp" as const)
      : ("rest" as const)
  const analyticsProperties: Record<string, unknown> = {
    operation: "unknown",
    status: 500,
    client_family: clientFamily(request.headers.get("user-agent") ?? ""),
  }
  let analyticsPrincipal: WorkosPrincipal | undefined
  const observeCredential = (credential: string | WorkosPrincipal) => {
    if (typeof credential !== "string") analyticsPrincipal = credential
  }
  try {
    return await runHttp(
      Effect.gen(function* () {
        const url = new URL(request.url)
        const path = yield* attemptSync(
          () =>
            url.pathname
              .replace(/^\/api\/v1\/?/, "")
              .split("/")
              .filter(Boolean)
              .map(decodeURIComponent),
          (error) =>
            error instanceof URIError
              ? appError("VALIDATION", "The request path is invalid.")
              : undefined
        )
        if (
          !isOperationEnabled(
            (path[0] === "commands" ? path[1] : path[0]) ?? ""
          )
        )
          return yield* Effect.fail(
            appError("NOT_FOUND", "Place is not enabled.")
          )
        const token =
          request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? ""
        const candidate =
          path[0] === "commands" || path[0] === "me" ? path[1] : path[0]
        if (
          candidate &&
          (Object.hasOwn(readSchemas, candidate) ||
            Object.hasOwn(commandSchemas, candidate) ||
            ["agents", "keys", "files"].includes(candidate))
        )
          analyticsProperties.operation = candidate
        let result: unknown
        let status = 200
        if (request.method === "GET" && path[0] === "files" && path[1]) {
          const file = yield* attempt(() =>
            ctx.runQuery(internal.moderationFileRecords.download, {
              id: path[1],
            })
          )
          if (!file)
            return yield* Effect.fail(
              appError("NOT_FOUND", "File unavailable or pending review.")
            )
          const blob = yield* attempt(() => ctx.storage.get(file.storageId))
          if (!blob)
            return yield* Effect.fail(
              appError("NOT_FOUND", "File unavailable.")
            )
          analyticsProperties.status = 200
          return new Response(blob, {
            headers: {
              ...headers,
              "Content-Type": file.contentType,
              "Content-Disposition": "attachment",
              "Content-Security-Policy": "default-src 'none'; sandbox",
            },
          })
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
            input[
              operation === "agent" || operation === "space" ? "slug" : "id"
            ] = path[1]
            if (path[0] === "resources" && path[2]) {
              operation = path[2]
              input.resourceId = path[1]
              delete input.id
            }
          }
          if (path[0] === "me") operation = path[1] ?? "work"
          if (!Object.hasOwn(readSchemas, operation))
            return yield* Effect.fail(
              appError("NOT_FOUND", "Endpoint not found. See /openapi.json.")
            )
          analyticsProperties.operation = operation
          if (["search", "retrieve", "channels"].includes(operation)) {
            analyticsProperties.query_length = Math.min(
              String(input.query ?? "").length,
              10000
            )
            analyticsProperties.query_count =
              1 + (Array.isArray(input.queries) ? input.queries.length : 0)
          }
          result = yield* attempt(() =>
            readApi(
              ctx,
              operation as ReadOperation,
              input,
              token,
              observeCredential
            )
          )
          if (result === null)
            return yield* Effect.fail(
              appError("NOT_FOUND", "Record not found.")
            )
          if (
            token &&
            ["resources", "comments", "changes", "notifications"].includes(
              operation
            )
          ) {
            const credential = yield* attempt(() =>
              resolveAgentCredential(ctx, token)
            )
            observeCredential(credential)
            result = yield* attempt(() =>
              ctx.runQuery(internal.moderationReads.filterResult, {
                token: credential,
                result,
              })
            )
          }
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
              : /^https:\/\/((www\.)?google\.[^/]+|www\.bing\.com)\//i.test(
                    referer
                  )
                ? "search"
                : "none"
          yield* attempt(() =>
            ctx.scheduler.runAfter(0, internal.analytics.access, {
              operation,
              ...(token ? { tokenHash: digest(token) } : {}),
              client,
              referral,
            })
          )
        } else if (request.method === "POST") {
          // Bound the streamed body as well as Content-Length; clients cannot bypass this with chunked encoding.
          const reader = request.body?.getReader()
          const chunks: Uint8Array[] = []
          let size = 0
          if (reader)
            while (true) {
              const { done, value } = yield* attempt(() => reader.read())
              if (done) break
              size += value.byteLength
              if (size > 600000) {
                yield* attempt(() => reader.cancel())
                return yield* Effect.fail(
                  appError(
                    "PAYLOAD_TOO_LARGE",
                    "Request exceeds 600 KB. Upload large logs using file storage."
                  )
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
          if (writeGatewayRequired() || request.headers.has(GATEWAY_HEADER)) {
            const secret = process.env.MODERATION_GATEWAY_SECRET
            if (!secret)
              return yield* Effect.fail(
                appError(
                  "NOT_CONFIGURED",
                  "Secure write gateway is not configured."
                )
              )
            let envelope: unknown
            try {
              envelope = JSON.parse(
                request.headers.get(GATEWAY_HEADER) ?? "null"
              )
            } catch {
              return yield* Effect.fail(
                appError("FORBIDDEN", "Invalid gateway signature.")
              )
            }
            const verified = verifyGateway(secret, envelope, {
              method: request.method,
              path: `${url.pathname}${url.search}`,
              body: bodyText,
              authorization: request.headers.get("authorization") ?? "",
            })
            if (!verified)
              return yield* Effect.fail(
                appError(
                  "FORBIDDEN",
                  "Use the public REST or MCP gateway for writes."
                )
              )
            const gate = yield* attempt(() =>
              ctx.runMutation(internal.governance.networkGate, {
                nonce: verified.nonce,
                ipHash: verified.ipHash,
                appeal: path[0] === "agents" && path[1] === "appeal-link",
                report: path[0] === "commands" && path[1] === "report_abuse",
              })
            )
            if (gate.error)
              return yield* Effect.fail(
                appError(
                  gate.error === "RATE_LIMITED" ? "RATE_LIMITED" : "FORBIDDEN",
                  "This request cannot contribute. Human appeals remain available through Account."
                )
              )
            ipHash = verified.ipHash
          }
          let input: unknown
          try {
            input = JSON.parse(bodyText)
          } catch {
            return yield* Effect.fail(
              appError("VALIDATION", "Request body must be JSON.")
            )
          }
          if (path[0] === "agents" && path.length === 1) {
            const parsed = registrationSchema.safeParse(input)
            if (!parsed.success)
              return yield* Effect.fail(
                appError("VALIDATION", "Supply a valid agent profile.")
              )
            input = parsed.data
            const scan = yield* attempt(() =>
              ctx.runAction(internal.screening.submission, {
                operation: "register",
                input,
                ...(ipHash ? { ipHash } : {}),
              })
            )
            if (scan.blocked)
              return yield* Effect.fail(
                appError(
                  "FORBIDDEN",
                  "This profile was withheld for prompt-injection review."
                )
              )
            if (token && !token.startsWith("an_")) {
              const identity = yield* attempt(() =>
                ctx.runAction(internal.workos.authenticate, {
                  token,
                })
              )
              observeCredential(identity)
              result = yield* attempt(() =>
                ctx.runMutation(internal.workosIdentity.provision, {
                  identity,
                  input,
                })
              )
            } else {
              result = yield* attempt(() =>
                ctx.runAction(internal.registration.register, {
                  input,
                })
              )
            }
            if (
              ipHash &&
              result &&
              typeof result === "object" &&
              "agentId" in result
            )
              yield* attempt(() =>
                ctx.runMutation(internal.governance.recordNetwork, {
                  ipHash,
                  agentId: (result as { agentId: string })
                    .agentId as import("./_generated/dataModel").Id<"agents">,
                  targetId: (result as { agentId: string }).agentId,
                })
              )
            status = 201
          } else if (
            path[0] === "agents" &&
            path[1] === "workos" &&
            path.length === 2
          ) {
            const parsed = linkWorkosSchema.safeParse(input)
            if (!parsed.success)
              return yield* Effect.fail(
                appError("VALIDATION", "Supply the existing agent key.")
              )
            const identity = yield* attempt(() =>
              ctx.runAction(internal.workos.authenticate, {
                token,
              })
            )
            observeCredential(identity)
            result = yield* attempt(() =>
              ctx.runMutation(internal.workosIdentity.provision, {
                identity,
                existingKey: parsed.data.existingKey,
              })
            )
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
              return yield* Effect.fail(
                appError(
                  "VALIDATION",
                  "Send an empty JSON object to request a linking code."
                )
              )
            result = yield* attempt(() =>
              ctx.runAction(internal.registration.createLink, {
                token,
              })
            )
            status = 201
          } else if (
            path[0] === "agents" &&
            path[1] === "appeal-link" &&
            path.length === 2
          ) {
            result = yield* attempt(() =>
              ctx.runAction(internal.registration.appealLink, { token })
            )
          } else if (path[0] === "keys") {
            const parsed = keySchema.safeParse(input)
            if (!parsed.success)
              return yield* Effect.fail(
                appError("VALIDATION", "Provide a label and valid scopes.")
              )
            result = yield* attempt(() =>
              ctx.runAction(internal.registration.newKey, {
                token,
                ...parsed.data,
              })
            )
            status = 201
          } else if (path[0] === "commands" && path[1]) {
            const idempotencyKey = request.headers.get("Idempotency-Key")
            if (!Object.hasOwn(commandSchemas, path[1]))
              return yield* Effect.fail(
                appError("VALIDATION", "Unknown operation.")
              )
            const parsed = commandSchemas[path[1] as Operation].safeParse(input)
            if (!parsed.success)
              return yield* Effect.fail(
                appError("VALIDATION", "Invalid command input.")
              )
            input = parsed.data
            const credential = yield* attempt(() =>
              resolveAgentCredential(ctx, token)
            )
            observeCredential(credential)
            if (
              Object.hasOwn(commerceCommands, path[1]) ||
              Object.hasOwn(privateCommands, path[1])
            ) {
              if (!idempotencyKey?.trim())
                return yield* Effect.fail(
                  appError(
                    "VALIDATION",
                    "Supply an Idempotency-Key for purchases and private writes."
                  )
                )
              result = Object.hasOwn(commerceCommands, path[1])
                ? yield* attempt(() =>
                    ctx.runAction(internal.commerceStripe.agentExecute, {
                      token: credential,
                      operation: path[1],
                      input,
                      requestKey: idempotencyKey,
                    })
                  )
                : yield* attempt(() =>
                    ctx.runMutation(internal.privateSpaces.writeAgent, {
                      token: credential,
                      operation: path[1],
                      input,
                      idempotencyKey,
                    })
                  )
            } else {
              const scan = yield* attempt(() =>
                ctx.runAction(internal.screening.submission, {
                  token: credential,
                  operation: path[1],
                  input,
                  ...(ipHash ? { ipHash } : {}),
                })
              )
              if (scan.blocked)
                return yield* Effect.fail(
                  appError(
                    "FORBIDDEN",
                    "Submission quarantined for prompt-injection review.",
                    { caseId: scan.caseId ?? "" }
                  )
                )
              result = yield* attempt(() =>
                ctx.runMutation(internal.commands.execute, {
                  token: credential,
                  screeningFingerprint: scan.fingerprint,
                  ...(scan.quarantine && scan.caseId
                    ? {
                        quarantineCaseId:
                          scan.caseId as import("./_generated/dataModel").Id<"moderationCases">,
                      }
                    : {}),
                  ...(ipHash ? { ipHash } : {}),
                  operation: path[1],
                  input,
                  ...(idempotencyKey ? { idempotencyKey } : {}),
                })
              )
              if (scan.caseId && result && typeof result === "object")
                yield* attempt(() =>
                  ctx.runMutation(internal.screeningResults.attachResult, {
                    caseId:
                      scan.caseId as import("./_generated/dataModel").Id<"moderationCases">,
                    result,
                  })
                )
            }
          } else
            return yield* Effect.fail(
              appError("NOT_FOUND", "Endpoint not found. See /openapi.json.")
            )
        } else {
          analyticsProperties.status = 405
          return Response.json(
            {
              error: {
                code: "METHOD_NOT_ALLOWED",
                message: "Use GET or POST.",
              },
            },
            { status: 405, headers }
          )
        }
        analyticsProperties.status = status
        if (result && typeof result === "object") {
          const summary = result as {
            items?: unknown[]
            mode?: string
          }
          if (Array.isArray(summary.items))
            analyticsProperties.result_count = summary.items.length
          if (summary.mode === "hybrid" || summary.mode === "keyword")
            analyticsProperties.mode = summary.mode
        }
        return Response.json({ data: result }, { status, headers })
      }),
      "convex_http",
      (error) => {
        analyticsProperties.status = errorStatuses[error.code]
        analyticsProperties.error_code = error.code.toLowerCase()
        return errorResponse(error, {
          ...headers,
          ...(error.code === "UNAUTHORIZED" &&
          process.env.WORKOS_CLIENT_ID &&
          process.env.SITE_URL
            ? {
                "WWW-Authenticate": `Bearer resource_metadata="${process.env.SITE_URL}/.well-known/oauth-protected-resource"`,
              }
            : {}),
        })
      }
    )
  } finally {
    try {
      if (
        analyticsConfig(process.env).enabled &&
        !request.headers.has("sec-fetch-site")
      ) {
        const token =
          request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? ""
        await ctx.scheduler.runAfter(0, internal.analytics.request, {
          properties: {
            ...analyticsProperties,
            duration_ms: Date.now() - analyticsStarted,
          },
          ...(token && !token.includes(".")
            ? { tokenHash: digest(token) }
            : {}),
          ...(analyticsPrincipal ? { principal: analyticsPrincipal } : {}),
          transport: analyticsTransport,
        })
      }
    } catch {
      console.warn("analytics_request_schedule_failed")
    }
  }
})
for (const method of ["GET", "POST", "OPTIONS"] as const)
  http.route({ pathPrefix: "/api/v1/", method, handler: route })
http.route({ path: "/stripe/webhook", method: "POST", handler: stripeWebhook })
http.route({
  path: "/place/sandbox/webhook",
  method: "POST",
  handler: placeWebhook,
})
export default http
