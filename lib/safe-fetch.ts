import { Effect } from "effect"
import { appError, externalError } from "./errors"
import { attemptSync, external, fetchEffect, runEffect } from "./effects"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { Agent, fetch } from "undici"
import ipaddr from "ipaddr.js"

export function isPublicAddress(address: string): boolean {
  try {
    let parsed = ipaddr.parse(address)
    if (
      parsed.kind() === "ipv6" &&
      (parsed as ipaddr.IPv6).isIPv4MappedAddress()
    )
      parsed = (parsed as ipaddr.IPv6).toIPv4Address()
    return parsed.range() === "unicast"
  } catch {
    return false
  }
}
export function validateSourceUrl(value: string): URL {
  const url = URL.parse(value)
  if (!url) throw appError("VALIDATION", "Supply a valid source URL.")
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw appError(
      "VALIDATION",
      "Only public HTTP/HTTPS sources on standard ports are supported."
    )
  const host = url.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    !host.includes(".")
  ) {
    if (!isIP(host) || !isPublicAddress(host))
      throw appError(
        "VALIDATION",
        "Private or local source addresses are not allowed."
      )
  }
  if (isIP(host) && !isPublicAddress(host))
    throw appError(
      "VALIDATION",
      "Private or reserved source addresses are not allowed."
    )
  return url
}

export type SourceText = {
  url: string
  text: string
  contentType: string
  bytes: number
}
export function safeFetchTextEffect(
  value: string,
  maximumBytes = 2 * 1024 * 1024
) {
  return Effect.gen(function* () {
    let url = yield* attemptSync(() => validateSourceUrl(value))
    const deadline = Date.now() + 12_000
    for (let hop = 0; hop <= 4; hop++) {
      const hostname = url.hostname.replace(/^\[|\]$/g, "")
      const remaining = deadline - Date.now()
      if (remaining <= 0)
        return yield* Effect.fail(
          appError("TIMEOUT", "Source retrieval timed out.")
        )
      const addresses = yield* external(async () => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          return await Promise.race([
            lookup(hostname, { all: true }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(appError("TIMEOUT", "Source DNS lookup timed out.")),
                Math.min(4000, remaining)
              )
            }),
          ])
        } finally {
          clearTimeout(timer)
        }
      }, "Source retrieval")
      if (
        !addresses.length ||
        addresses.some((a) => !isPublicAddress(a.address))
      )
        return yield* Effect.fail(
          appError(
            "VALIDATION",
            "The source resolves to a private or reserved network."
          )
        )
      const currentUrl = url
      // Each hop pins only validated DNS results, and releases its connection before redirecting.
      const result = yield* Effect.acquireUseRelease(
        Effect.sync(
          () =>
            new Agent({
              connect: {
                lookup: (_hostname, options, callback) => {
                  if (options.all) callback(null, addresses)
                  else callback(null, addresses[0].address, addresses[0].family)
                },
              },
            })
        ),
        (dispatcher) =>
          Effect.gen(function* () {
            const response = yield* fetchEffect(
              () =>
                fetch(currentUrl, {
                  dispatcher,
                  redirect: "manual",
                  signal: AbortSignal.timeout(
                    Math.max(1, deadline - Date.now())
                  ),
                  headers: {
                    "User-Agent": "AgentNotepadSourceCheck/1.0",
                    Accept: "text/html,text/plain,application/json;q=0.8",
                  },
                }) as unknown as Promise<Response>,
              "Source retrieval"
            )
            if ([301, 302, 303, 307, 308].includes(response.status)) {
              yield* external(async () => {
                await response.body?.cancel()
              }, "Source retrieval")
              const location = response.headers.get("location")
              if (!location || hop === 4)
                return yield* Effect.fail(
                  appError("BAD_GATEWAY", "The source has too many redirects.")
                )
              const target = URL.parse(location, currentUrl)
              if (!target)
                return yield* Effect.fail(
                  appError(
                    "BAD_GATEWAY",
                    "The source returned an invalid redirect."
                  )
                )
              return {
                redirect: yield* attemptSync(() =>
                  validateSourceUrl(target.href)
                ),
              } as const
            }
            const contentType = response.headers.get("content-type") ?? ""
            const invalid = !response.ok
              ? (externalError(
                  { status: response.status },
                  "Source retrieval"
                ) ?? appError("BAD_GATEWAY", "Source retrieval failed."))
              : !/(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType)
                ? appError(
                    "VALIDATION",
                    "This source needs a text-accessible version for automatic checking."
                  )
                : Number(response.headers.get("content-length") ?? 0) >
                    maximumBytes
                  ? appError(
                      "PAYLOAD_TOO_LARGE",
                      "Source exceeds the retrieval size limit."
                    )
                  : null
            if (invalid) {
              yield* external(async () => {
                await response.body?.cancel()
              }, "Source retrieval")
              return yield* Effect.fail(invalid)
            }
            const reader = response.body?.getReader()
            if (!reader)
              return yield* Effect.fail(
                appError("BAD_GATEWAY", "Source has no response body.")
              )
            const textResult = yield* Effect.acquireUseRelease(
              Effect.succeed(reader),
              (reader) =>
                Effect.gen(function* () {
                  const decoder = new TextDecoder()
                  let bytes = 0,
                    text = ""
                  while (true) {
                    const part = yield* external(
                      () => reader.read(),
                      "Source retrieval"
                    )
                    if (part.done) break
                    bytes += part.value.byteLength
                    if (bytes > maximumBytes)
                      return yield* Effect.fail(
                        appError(
                          "PAYLOAD_TOO_LARGE",
                          "Source exceeds the retrieval size limit."
                        )
                      )
                    text += decoder.decode(part.value, { stream: true })
                  }
                  return {
                    url: currentUrl.href,
                    text: text + decoder.decode(),
                    contentType,
                    bytes,
                  }
                }),
              (reader) =>
                Effect.promise(async () => {
                  try {
                    await reader.cancel()
                  } catch (error) {
                    if (!externalError(error, "Source retrieval")) throw error
                  } finally {
                    reader.releaseLock()
                  }
                })
            )
            return { result: textResult } as const
          }),
        (dispatcher) =>
          Effect.promise(async () => {
            await dispatcher.close()
          })
      )
      if (result.result !== undefined) return result.result
      url = result.redirect
    }
    return yield* Effect.fail(
      appError("BAD_GATEWAY", "Source retrieval failed.")
    )
  })
}
export const safeFetchText = (
  value: string,
  maximumBytes?: number
): Promise<SourceText> => runEffect(safeFetchTextEffect(value, maximumBytes))
export function plainText(html: string) {
  return html
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim()
}
