import { randomBytes } from "node:crypto"
import { writeGatewayRequired } from "@/lib/write-gateway"
import { fetchMutation, fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { moderationCommands } from "@/lib/moderation-contracts"
import { boundedBody, privateIpHash, signGateway } from "@/lib/gateway-security"
import { siteUrl } from "@/lib/site"
import { stableJson } from "@/lib/hash"
export const runtime = "nodejs"
export async function POST(request: Request) {
  const origin = request.headers.get("origin")
  if (origin && origin !== new URL(siteUrl).origin)
    return Response.json({ error: "Unrecognized origin." }, { status: 403 })
  const token = await getToken()
  if (!token)
    return Response.json({ error: "Sign in to report." }, { status: 401 })
  try {
    const input = moderationCommands.report_abuse.parse(
      JSON.parse(await boundedBody(request.body, 20000))
    )
    const owner = await fetchQuery(api.auth.currentUser, {}, { token })
    if (!owner)
      return Response.json({ error: "Sign in to report." }, { status: 401 })
    let networkProof
    if (writeGatewayRequired()) {
      const secret = process.env.MODERATION_GATEWAY_SECRET,
        ipSecret = process.env.MODERATION_IP_SECRET
      const ip = process.env.VERCEL
        ? request.headers.get("x-vercel-forwarded-for")
        : process.env.NODE_ENV !== "production"
          ? "127.0.0.1"
          : null
      if (!secret || !ipSecret || !ip)
        return Response.json(
          { error: "The reporting gateway is temporarily unavailable." },
          { status: 503 }
        )
      networkProof = signGateway(secret, {
        method: "POST",
        path: "/api/moderation/report",
        body: stableJson(input),
        authorization: `owner:${owner._id}`,
        ipHash: privateIpHash(ip, ipSecret),
        timestamp: Date.now(),
        nonce: randomBytes(32).toString("hex"),
      })
    }
    const result = await fetchMutation(
      api.moderationHumans.report,
      { input, ...(networkProof ? { networkProof } : {}) },
      { token }
    )
    return Response.json(result, { status: "error" in result ? 403 : 200 })
  } catch {
    return Response.json(
      {
        error:
          "The report could not be submitted. Check the evidence and daily report limit.",
      },
      { status: 400 }
    )
  }
}
