import { Effect } from "effect"
import { appError } from "./errors"
import { attempt, attemptSync, fetchEffect, runHttp } from "./effects"
import "server-only"
import { writeGatewayRequired } from "./write-gateway"
import { isOperationEnabled } from "./features"
import { randomBytes } from "node:crypto"
import {
  GATEWAY_HEADER,
  privateIpHash,
  signGateway,
  boundedBody,
} from "./gateway-security"
export function backendSite() {
  const value = process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  if (!value)
    throw appError("NOT_CONFIGURED", "The backend gateway is not configured.")
  return value.replace(/\/$/, "")
}
export function forwardApiEffect(
  path: string,
  init: RequestInit = {},
  incoming?: Request,
  transport: "rest" | "mcp" = "rest"
) {
  return Effect.gen(function* () {
    const segments = yield* attemptSync(() =>
      path
        .split("?")[0]
        .split("/")
        .filter(Boolean)
        .map((segment) => {
          try {
            return decodeURIComponent(segment)
          } catch {
            throw appError("VALIDATION", "The request path is invalid.")
          }
        })
    )
    // Match the read dispatcher's aliases as well as canonical operation paths.
    const operation = ["commands", "me"].includes(segments[0])
      ? segments[1]
      : segments[0] === "resources" && segments[2]
        ? segments[2]
        : segments[0]
    if (!isOperationEnabled(operation ?? ""))
      return yield* Effect.fail(appError("NOT_FOUND", "Place is not enabled."))
    const headers = new Headers(init.headers)
    // Observational label only. Never use this header for identity or authorization.
    headers.set("x-agent-notepad-transport", transport)
    headers.delete("sec-fetch-site")
    if (incoming?.headers.has("sec-fetch-site"))
      headers.set("sec-fetch-site", incoming.headers.get("sec-fetch-site")!)
    headers.delete(GATEWAY_HEADER)
    const method = init.method ?? "GET"
    if (method === "POST") {
      const secret = process.env.MODERATION_GATEWAY_SECRET
      if (!secret && writeGatewayRequired())
        return yield* Effect.fail(
          appError("NOT_CONFIGURED", "Secure write gateway is not configured.")
        )
      if (secret) {
        if (!incoming)
          throw new Error("Signed writes require an incoming request")
        const ip = process.env.VERCEL
          ? incoming.headers.get("x-vercel-forwarded-for")
          : process.env.NODE_ENV !== "production"
            ? "127.0.0.1"
            : null
        if (!ip || !process.env.MODERATION_IP_SECRET)
          return yield* Effect.fail(
            appError("NOT_CONFIGURED", "Trusted client IP is unavailable.")
          )
        const ipSecret = process.env.MODERATION_IP_SECRET
        const body =
          typeof init.body === "string"
            ? init.body
            : yield* attempt(() =>
                boundedBody(init.body as ReadableStream<Uint8Array> | null)
              )
        const envelope = yield* attemptSync(() =>
          signGateway(secret, {
            method,
            path: `/api/v1/${path}`,
            body,
            authorization: headers.get("authorization") ?? "",
            ipHash: privateIpHash(ip, ipSecret!),
            nonce: randomBytes(32).toString("hex"),
            timestamp: Date.now(),
          })
        )
        headers.set(GATEWAY_HEADER, JSON.stringify(envelope))
        init = { ...init, body }
      }
    }
    const backend = yield* attemptSync(backendSite)
    return yield* fetchEffect(
      () =>
        fetch(`${backend}/api/v1/${path}`, {
          ...init,
          headers,
          cache: "no-store",
          signal: AbortSignal.timeout(55000),
        }),
      "Backend gateway"
    )
  })
}
export const forwardApi = (
  path: string,
  init: RequestInit = {},
  incoming?: Request,
  transport: "rest" | "mcp" = "rest"
) => runHttp(forwardApiEffect(path, init, incoming, transport), "gateway")
