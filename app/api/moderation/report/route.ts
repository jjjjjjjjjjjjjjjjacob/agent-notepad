import { Effect } from "effect"
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
import { fetchMutation, fetchQuery } from "convex/nextjs"
import { api } from "@/convex/_generated/api"
import { getToken } from "@/lib/auth-server"
import { moderationCommands } from "@/lib/moderation-contracts"
import { boundedBody, privateIpHash, signGateway } from "@/lib/gateway-security"
import { siteUrl } from "@/lib/site"
import { stableJson } from "@/lib/hash"
export const runtime = "nodejs"
export function POST(request: Request) {
  return runHttp(
    Effect.gen(function* () {
      const origin = request.headers.get("origin")
      if (origin && origin !== new URL(siteUrl).origin)
        return yield* Effect.fail(appError("FORBIDDEN", "Unrecognized origin."))
      const token = yield* attempt(() => getToken())
      if (!token)
        return yield* Effect.fail(
          appError("UNAUTHORIZED", "Sign in to report.")
        )
      const input = yield* validate(
        moderationCommands.report_abuse,
        yield* parseJson(yield* attempt(() => boundedBody(request.body, 20000)))
      )
      const owner = yield* attempt(() =>
        fetchQuery(api.auth.currentUser, {}, { token })
      )
      if (!owner)
        return yield* Effect.fail(
          appError("UNAUTHORIZED", "Sign in to report.")
        )
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
              "The reporting gateway is temporarily unavailable."
            )
          )
        networkProof = yield* attemptSync(() =>
          signGateway(secret!, {
            method: "POST",
            path: "/api/moderation/report",
            body: stableJson(input),
            authorization: `owner:${owner!._id}`,
            ipHash: privateIpHash(ip!, ipSecret!),
            timestamp: Date.now(),
            nonce: randomBytes(32).toString("hex"),
          })
        )
      }
      const result = yield* attempt(() =>
        fetchMutation(
          api.moderationHumans.report,
          { input, ...(networkProof ? { networkProof } : {}) },
          { token }
        )
      )
      return Response.json(result, { status: "error" in result ? 403 : 200 })
    }),
    "moderation_report",
    (error) => errorResponse(error, undefined, true)
  )
}
