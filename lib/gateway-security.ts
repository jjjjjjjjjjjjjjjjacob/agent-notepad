import { appError } from "./errors"
import ipaddr from "ipaddr.js"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { digest, stableJson } from "./hash"
export const GATEWAY_HEADER = "x-agent-notepad-gateway"
export type GatewayEnvelope = {
  timestamp: number
  nonce: string
  ipHash: string
  signature: string
}
const mac = (secret: string, value: string) =>
  bytesToHex(
    hmac(
      sha256,
      new TextEncoder().encode(secret),
      new TextEncoder().encode(value)
    )
  )
export function normalizeIp(value: string) {
  if (
    value.includes(",") ||
    value.includes("%") ||
    !ipaddr.isValid(value.trim())
  )
    throw appError("NOT_CONFIGURED", "Trusted client IP is unavailable.")
  return ipaddr.process(value.trim()).toString()
}
export function privateIpHash(value: string, secret: string) {
  return mac(secret, `ip-v1:${normalizeIp(value)}`)
}
function signedText(
  method: string,
  path: string,
  body: string,
  authorization: string,
  timestamp: number,
  nonce: string,
  ipHash: string
) {
  return stableJson({
    version: 1,
    method: method.toUpperCase(),
    path,
    bodyHash: digest(body),
    credentialHash: digest(authorization),
    timestamp,
    nonce,
    ipHash,
  })
}
export function signGateway(
  secret: string,
  request: {
    method: string
    path: string
    body: string
    authorization: string
    ipHash: string
    nonce: string
    timestamp: number
  }
): GatewayEnvelope {
  return {
    timestamp: request.timestamp,
    nonce: request.nonce,
    ipHash: request.ipHash,
    signature: mac(
      secret,
      signedText(
        request.method,
        request.path,
        request.body,
        request.authorization,
        request.timestamp,
        request.nonce,
        request.ipHash
      )
    ),
  }
}
export function verifyGateway(
  secret: string,
  envelope: unknown,
  request: {
    method: string
    path: string
    body: string
    authorization: string
  },
  now = Date.now()
): GatewayEnvelope | null {
  if (!envelope || typeof envelope !== "object") return null
  const e = envelope as GatewayEnvelope
  if (
    !Number.isSafeInteger(e.timestamp) ||
    Math.abs(now - e.timestamp) > 60000 ||
    !/^[a-f0-9]{64}$/.test(e.nonce) ||
    !/^[a-f0-9]{64}$/.test(e.ipHash) ||
    !/^[a-f0-9]{64}$/.test(e.signature)
  )
    return null
  const expected = signGateway(secret, {
    ...request,
    timestamp: e.timestamp,
    nonce: e.nonce,
    ipHash: e.ipHash,
  }).signature
  let different = 0
  for (let i = 0; i < expected.length; i++)
    different |= expected.charCodeAt(i) ^ e.signature.charCodeAt(i)
  return different === 0 ? e : null
}
export async function boundedBody(
  body: ReadableStream<Uint8Array> | null,
  limit = 600000
) {
  const reader = body?.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  if (reader)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) {
        await reader.cancel()
        throw appError(
          "PAYLOAD_TOO_LARGE",
          "Request exceeds the body size limit."
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
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw appError("VALIDATION", "Request body must contain valid UTF-8.")
  }
}
