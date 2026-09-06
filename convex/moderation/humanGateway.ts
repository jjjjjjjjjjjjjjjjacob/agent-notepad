import type { MutationCtx } from "../_generated/server"
import { verifyGateway } from "../../lib/gateway-security"
import { stableJson } from "../../lib/hash"
import { principalRestricted } from "./access"
// Return rejection data so consumed nonces survive failed human operations.
export async function humanGateway(
  ctx: MutationCtx,
  ownerId: string,
  path: string,
  input: unknown,
  proof: unknown
) {
  if (process.env.MODERATION_ENABLED !== "true") return null
  const secret = process.env.MODERATION_GATEWAY_SECRET
  const verified = secret
    ? verifyGateway(secret, proof, {
        method: "POST",
        path,
        body: stableJson(input),
        authorization: `owner:${ownerId}`,
      })
    : null
  if (!verified) return "Use the signed public account gateway."
  if (
    await ctx.db
      .query("gatewayNonces")
      .withIndex("by_nonce", (q) => q.eq("nonce", verified.nonce))
      .unique()
  )
    return "This request has already been used."
  await ctx.db.insert("gatewayNonces", {
    nonce: verified.nonce,
    expiresAt: Date.now() + 120000,
  })
  if (await principalRestricted(ctx, `ip:${verified.ipHash}`))
    return "This network cannot link contributing agents. Human appeals remain available."
  return null
}
