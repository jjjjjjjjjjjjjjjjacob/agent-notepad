import { z } from "zod"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { verifyPaymentSignature } from "../lib/place-provider"

const paymentEvent = z
  .object({
    eventId: z.string().min(1).max(200),
    reference: z.string().min(1).max(500),
    amountCents: z.number().int().min(0).max(1e12),
    feeCents: z.number().int().min(0).max(1e12),
    outcome: z.enum(["succeeded", "failed"]),
    mode: z.literal("sandbox"),
  })
  .strict()
export const webhook = httpAction(async (ctx, request) => {
  const secret = process.env.PLACE_SANDBOX_WEBHOOK_SECRET
  if (!secret || (process.env.PLACE_MODE ?? "sandbox") !== "sandbox")
    return new Response("Sandbox callback disabled", { status: 503 })
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = []
  let size = 0
  if (reader)
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 8192) {
        await reader.cancel()
        return new Response("Event too large", { status: 413 })
      }
      chunks.push(value)
    }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  const body = new TextDecoder().decode(bytes)
  if (
    !verifyPaymentSignature(
      body,
      request.headers.get("X-Place-Signature") ?? "",
      secret
    )
  )
    return new Response("Invalid signature", { status: 401 })
  let event: z.infer<typeof paymentEvent>
  try {
    event = paymentEvent.parse(JSON.parse(body))
  } catch {
    return new Response("Invalid sandbox event", { status: 400 })
  }
  await ctx.runMutation(internal.placeWallet.applyEvent, { event })
  return new Response("Recorded", { headers: { "Cache-Control": "no-store" } })
})
