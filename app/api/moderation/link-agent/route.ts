import { Effect } from "effect"
import { z } from "zod"
import { appError } from "@/lib/errors"
import {
  attempt,
  attemptSync,
  errorResponse,
  parseJson,
  runHttp,
  validate,
} from "@/lib/effects"
import { randomBytes } from "node:crypto"
import { writeGatewayRequired } from "@/lib/write-gateway"
import { fetchAction, fetchMutation, fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { boundedBody, privateIpHash, signGateway } from "@/lib/gateway-security"
import { stableJson } from "@/lib/hash"
import { siteUrl } from "@/lib/site"
export const runtime = "nodejs"
export function POST(request: Request) {
  return runHttp(
    Effect.gen(function* () {
      if (
        request.headers.get("origin") &&
        request.headers.get("origin") !== new URL(siteUrl).origin
      )
        return yield* Effect.fail(appError("FORBIDDEN", "Unrecognized origin."))
      const token = yield* attempt(() => getToken())
      if (!token)
        return yield* Effect.fail(appError("UNAUTHORIZED", "Sign in first."))
      const input = yield* validate(
        z.union([
          z.object({ claimAttemptToken: z.string().min(1).max(1000) }),
          z.object({ linkingCode: z.string().min(1).max(200) }),
        ]),
        yield* parseJson(yield* attempt(() => boundedBody(request.body, 2000))),
        "Invalid linking code."
      )
      const owner = yield* attempt(() =>
        fetchQuery(api.auth.currentUser, {}, { token })
      )
      if (!owner)
        return yield* Effect.fail(appError("UNAUTHORIZED", "Sign in first."))
      let networkProof: ReturnType<typeof signGateway> | undefined
      if (writeGatewayRequired()) {
        const secret = process.env.MODERATION_GATEWAY_SECRET,
          ipSecret = process.env.MODERATION_IP_SECRET
        const ip = process.env.VERCEL
          ? request.headers.get("x-vercel-forwarded-for")
          : process.env.NODE_ENV !== "production"
            ? "127.0.0.1"
            : null
        if (!secret || !ipSecret || !ip)
          return yield* Effect.fail(
            appError(
              "NOT_CONFIGURED",
              "The account gateway is temporarily unavailable."
            )
          )
        networkProof = yield* attemptSync(() =>
          signGateway(secret!, {
            method: "POST",
            path: "/api/moderation/link-agent",
            body: stableJson(input),
            authorization: `owner:${owner!._id}`,
            ipHash: privateIpHash(ip!, ipSecret!),
            timestamp: Date.now(),
            nonce: randomBytes(32).toString("hex"),
          })
        )
      }
      const result =
        "claimAttemptToken" in input
          ? yield* attempt(() =>
              fetchAction(
                api.workos.claim,
                { ...input, ...(networkProof ? { networkProof } : {}) },
                { token }
              )
            )
          : yield* attempt(() =>
              fetchMutation(
                api.auth.linkAgent,
                { ...input, ...(networkProof ? { networkProof } : {}) },
                { token }
              )
            )
      return Response.json(result, { status: "error" in result ? 403 : 200 })
    }),
    "moderation_link_agent",
    (error) => errorResponse(error, undefined, true)
  )
}
