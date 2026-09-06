import "server-only"
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
    throw new Error(
      "NEXT_PUBLIC_CONVEX_SITE_URL is required. Run bun run backend first."
    )
  return value.replace(/\/$/, "")
}
export async function forwardApi(
  path: string,
  init: RequestInit = {},
  incoming?: Request
) {
  const segments = path
    .split("?")[0]
    .split("/")
    .filter(Boolean)
    .map(decodeURIComponent)
  // Match the read dispatcher's aliases as well as canonical operation paths.
  const operation = ["commands", "me"].includes(segments[0])
    ? segments[1]
    : segments[0] === "resources" && segments[2]
      ? segments[2]
      : segments[0]
  if (!isOperationEnabled(operation ?? ""))
    return Response.json(
      { error: { code: "NOT_FOUND", message: "Place is not enabled." } },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    )
  const headers = new Headers(init.headers)
  headers.delete(GATEWAY_HEADER)
  const method = init.method ?? "GET"
  if (method === "POST") {
    const secret = process.env.MODERATION_GATEWAY_SECRET
    if (!secret && process.env.MODERATION_ENABLED === "true")
      return Response.json(
        {
          error: {
            code: "NOT_CONFIGURED",
            message: "Secure write gateway is not configured.",
          },
        },
        { status: 503 }
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
        return Response.json(
          {
            error: {
              code: "NOT_CONFIGURED",
              message: "Trusted client IP is unavailable.",
            },
          },
          { status: 503 }
        )
      const body =
        typeof init.body === "string"
          ? init.body
          : await boundedBody(init.body as ReadableStream<Uint8Array> | null)
      const envelope = signGateway(secret, {
        method,
        path: `/api/v1/${path}`,
        body,
        authorization: headers.get("authorization") ?? "",
        ipHash: privateIpHash(ip, process.env.MODERATION_IP_SECRET),
        nonce: randomBytes(32).toString("hex"),
        timestamp: Date.now(),
      })
      headers.set(GATEWAY_HEADER, JSON.stringify(envelope))
      init = { ...init, body }
    }
  }
  return fetch(`${backendSite()}/api/v1/${path}`, {
    ...init,
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(55000),
  })
}
