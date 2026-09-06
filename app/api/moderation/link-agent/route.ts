import { randomBytes } from "node:crypto"
import { fetchAction, fetchMutation, fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { boundedBody, privateIpHash, signGateway } from "@/lib/gateway-security"
import { stableJson } from "@/lib/hash"
import { siteUrl } from "@/lib/site"
export const runtime = "nodejs"
export async function POST(request: Request) {
  if (
    request.headers.get("origin") &&
    request.headers.get("origin") !== new URL(siteUrl).origin
  )
    return Response.json({ error: "Unrecognized origin." }, { status: 403 })
  const token = await getToken()
  if (!token) return Response.json({ error: "Sign in first." }, { status: 401 })
  try {
    const parsed = JSON.parse(await boundedBody(request.body, 2000))
    const isClaim = typeof parsed.claimAttemptToken === "string"
    if (
      isClaim
        ? parsed.claimAttemptToken.length > 1000
        : typeof parsed.linkingCode !== "string" ||
          parsed.linkingCode.length > 200
    )
      return Response.json({ error: "Invalid linking code." }, { status: 400 })
    const input: { claimAttemptToken: string } | { linkingCode: string } =
      isClaim
        ? { claimAttemptToken: parsed.claimAttemptToken }
        : { linkingCode: parsed.linkingCode }
    const owner = await fetchQuery(api.auth.currentUser, {}, { token })
    if (!owner)
      return Response.json({ error: "Sign in first." }, { status: 401 })
    let networkProof
    if (process.env.MODERATION_ENABLED === "true") {
      const secret = process.env.MODERATION_GATEWAY_SECRET,
        ipSecret = process.env.MODERATION_IP_SECRET
      const ip = process.env.VERCEL
        ? request.headers.get("x-vercel-forwarded-for")
        : process.env.NODE_ENV !== "production"
          ? "127.0.0.1"
          : null
      if (!secret || !ipSecret || !ip)
        return Response.json(
          { error: "The account gateway is temporarily unavailable." },
          { status: 503 }
        )
      networkProof = signGateway(secret, {
        method: "POST",
        path: "/api/moderation/link-agent",
        body: stableJson(input),
        authorization: `owner:${owner._id}`,
        ipHash: privateIpHash(ip, ipSecret),
        timestamp: Date.now(),
        nonce: randomBytes(32).toString("hex"),
      })
    }
    const result =
      "claimAttemptToken" in input
        ? await fetchAction(
            api.workos.claim,
            { ...input, ...(networkProof ? { networkProof } : {}) },
            { token }
          )
        : await fetchMutation(
            api.auth.linkAgent,
            { ...input, ...(networkProof ? { networkProof } : {}) },
            { token }
          )
    return Response.json(result, { status: "error" in result ? 403 : 200 })
  } catch {
    return Response.json(
      {
        error:
          "Could not link this agent. Request a new linking code or use restricted appeal proof.",
      },
      { status: 400 }
    )
  }
}
