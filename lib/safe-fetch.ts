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
  const url = new URL(value)
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port && !["80", "443"].includes(url.port))
  )
    throw new Error(
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
      throw new Error("Private or local source addresses are not allowed.")
  }
  if (isIP(host) && !isPublicAddress(host))
    throw new Error("Private or reserved source addresses are not allowed.")
  return url
}

export async function safeFetchText(
  value: string,
  maximumBytes = 2 * 1024 * 1024
) {
  let url = validateSourceUrl(value)
  const deadline = Date.now() + 12_000
  for (let hop = 0; hop <= 4; hop++) {
    const hostname = url.hostname.replace(/^\[|\]$/g, "")
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new Error("Source retrieval timed out.")
    let dnsTimer: ReturnType<typeof setTimeout> | undefined
    const addresses = await Promise.race([
      lookup(hostname, { all: true }),
      new Promise<never>((_, reject) => {
        dnsTimer = setTimeout(
          () => reject(new Error("Source DNS lookup timed out.")),
          Math.min(4000, remaining)
        )
      }),
    ]).finally(() => clearTimeout(dnsTimer))
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
      throw new Error("The source resolves to a private or reserved network.")
    // Pin the validated DNS result during connection to prevent DNS rebinding.
    const dispatcher = new Agent({
      connect: {
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, addresses)
          else callback(null, addresses[0].address, addresses[0].family)
        },
      },
    })
    try {
      const response = await fetch(url, {
        dispatcher,
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        headers: {
          "User-Agent": "AgentNotepadSourceCheck/1.0",
          Accept: "text/html,text/plain,application/json;q=0.8",
        },
      })
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel()
        const location = response.headers.get("location")
        if (!location || hop === 4)
          throw new Error("The source has too many redirects.")
        url = validateSourceUrl(new URL(location, url).href)
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new Error(`Source returned HTTP ${response.status}.`)
      }
      const contentType = response.headers.get("content-type") ?? ""
      if (!/(text\/|application\/(json|xml|xhtml\+xml))/.test(contentType)) {
        await response.body?.cancel()
        throw new Error(
          "This source needs a text-accessible version for automatic checking."
        )
      }
      if (Number(response.headers.get("content-length") ?? 0) > maximumBytes) {
        await response.body?.cancel()
        throw new Error("Source exceeds the retrieval size limit.")
      }
      const reader = response.body?.getReader()
      if (!reader) throw new Error("Source has no response body.")
      const decoder = new TextDecoder()
      let bytes = 0
      let text = ""
      while (true) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > maximumBytes) {
          await reader.cancel()
          throw new Error("Source exceeds the retrieval size limit.")
        }
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
      return { url: url.href, text, contentType, bytes }
    } finally {
      await dispatcher.close()
    }
  }
  throw new Error("Source retrieval failed.")
}
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
