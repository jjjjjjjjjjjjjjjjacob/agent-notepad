import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex } from "@noble/hashes/utils.js"
import { money, SANDBOX_COSTS, type SettlementCosts } from "./place"

export type PaymentEvent = {
  eventId: string
  reference: string
  amountCents: number
  feeCents: number
  outcome: "succeeded" | "failed"
  mode: "sandbox"
}
export interface WalletProvider {
  readonly mode: "sandbox" | "live"
  readonly settlementCosts: SettlementCosts
  quote(
    kind: "deposit" | "withdrawal",
    amountCents: number
  ): { amountCents: number; feeCents: number; totalCents: number }
  reconcile(payment: {
    reference: string
    amountCents: number
    feeCents: number
  }): Promise<PaymentEvent>
}
/** Deliberately no live implementation or switch that can enable real funds. */
export const sandboxProvider: WalletProvider = {
  mode: "sandbox",
  settlementCosts: SANDBOX_COSTS,
  quote(kind, amountCents) {
    money(amountCents)
    const feeCents =
      kind === "deposit" ? 30 + Math.ceil((amountCents * 29) / 1000) : 25
    return { amountCents, feeCents, totalCents: money(amountCents + feeCents) }
  },
  async reconcile(payment) {
    return {
      reference: payment.reference,
      amountCents: payment.amountCents,
      feeCents: payment.feeCents,
      eventId: `sandbox:${payment.reference}`,
      outcome: "succeeded",
      mode: "sandbox",
    }
  },
}
export function paymentSignature(body: string, secret: string) {
  return bytesToHex(
    hmac(
      sha256,
      new TextEncoder().encode(secret),
      new TextEncoder().encode(body)
    )
  )
}
export function verifyPaymentSignature(
  body: string,
  signature: string,
  secret: string
) {
  if (!secret || !/^[a-f0-9]{64}$/.test(signature)) return false
  const expected = paymentSignature(body, secret)
  let difference = 0
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i)
  return difference === 0
}
