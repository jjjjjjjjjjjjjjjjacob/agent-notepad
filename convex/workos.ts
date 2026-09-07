"use node"
import { Effect } from "effect"
import { appError, externalError } from "../lib/errors"
import { attempt, attemptSync, external, runConvex } from "../lib/effects"
import { WorkOS } from "@workos-inc/node"
import { v } from "convex/values"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { fail } from "./lib/core"
import { validatedAgentClaims } from "../lib/workos-agent"
import type { WorkosPrincipal } from "./lib/agentIdentity"

type Configuration = {
  apiKey: string
  clientId: string
  issuer: string
  audience: string
}
let cachedClient: { configuration: Configuration; workos: WorkOS } | undefined

function configuration(): Configuration {
  const apiKey = process.env.WORKOS_API_KEY
  const clientId = process.env.WORKOS_CLIENT_ID
  const issuer = process.env.WORKOS_AUTHKIT_ISSUER
  if (!apiKey || !clientId || !issuer) {
    cachedClient = undefined
    fail("NOT_CONFIGURED", "WorkOS Agent Registration is not configured.")
  }
  return {
    apiKey,
    clientId,
    issuer,
    audience: process.env.WORKOS_AGENT_AUDIENCE ?? clientId,
  }
}

function client(settings = configuration()) {
  const previous = cachedClient?.configuration
  if (
    !previous ||
    previous.apiKey !== settings.apiKey ||
    previous.clientId !== settings.clientId ||
    previous.issuer !== settings.issuer ||
    previous.audience !== settings.audience
  ) {
    cachedClient = {
      configuration: settings,
      workos: new WorkOS(settings.apiKey, {
        clientId: settings.clientId,
        timeout: 10_000,
        maxRetries: 1,
      }),
    }
  }
  // Only the SDK's key cache is reused. Authorization is checked on every call.
  return cachedClient!.workos
}

export const authenticate = internalAction({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<WorkosPrincipal> => {
    return runConvex(
      Effect.gen(function* () {
        if (!token || token.length > 16384 || token.split(".").length !== 3)
          return yield* Effect.fail(
            appError("UNAUTHORIZED", "Supply a WorkOS agent access token.")
          )
        const settings = yield* attemptSync(configuration)
        // A separate committed mutation bounds external work across warm/cold
        // workers. A later authentication failure cannot roll this admission back.
        const retryAfterSeconds = yield* attempt(() =>
          ctx.runMutation(internal.workosIdentity.authenticateLimit, {})
        )
        if (retryAfterSeconds !== null)
          return yield* Effect.fail(
            appError(
              "RATE_LIMITED",
              "WorkOS authentication capacity reached. Retry later.",
              { retryAfterSeconds }
            )
          )
        const workos = yield* attemptSync(() => client(settings))
        const validation = yield* attempt(
          () =>
            workos.agents.validateCredential({
              type: "access_token",
              credential: token,
              audience: settings.audience,
              checkForRevoked: true,
            }),
          (error) =>
            error &&
            typeof error === "object" &&
            "code" in error &&
            error.code === "ERR_JWKS_NO_MATCHING_KEY"
              ? appError(
                  "UNAUTHORIZED",
                  "Agent token is invalid, expired, or revoked."
                )
              : externalError(error, "WorkOS")
        )
        if (!validation.valid)
          return yield* Effect.fail(
            appError(
              "UNAUTHORIZED",
              "Agent token is invalid, expired, or revoked."
            )
          )
        const registration = yield* external(
          () => workos.agents.getRegistration(validation.registrationId),
          "WorkOS"
        )
        const checked = yield* attemptSync(() =>
          validatedAgentClaims(validation, registration, {
            issuer: settings.issuer,
            audience: settings.audience,
          })
        )
        // Ownership comes from the verified WorkOS user, never an email or ID sent by an agent.
        const ownerId = checked.workosUserId
          ? (yield* external(
              () => workos.userManagement.getUser(checked.workosUserId!),
              "WorkOS"
            )).externalId
          : null
        const identity: WorkosPrincipal = {
          registrationId: checked.registrationId,
          scopes: checked.scopes,
          expiresAt: checked.expiresAt,
          ...(ownerId ? { ownerId } : {}),
        }
        if (checked.workosUserId && !ownerId)
          return yield* Effect.fail(
            appError(
              "FORBIDDEN",
              "Claim this agent through this app's account page."
            )
          )
        yield* attempt(() =>
          ctx.runMutation(internal.workosIdentity.provision, { identity })
        )
        return identity
      }),
      "workos_authenticate"
    )
  },
})

export const claim = action({
  args: { claimAttemptToken: v.string(), networkProof: v.optional(v.any()) },
  handler: async (
    ctx,
    { claimAttemptToken, networkProof }
  ): Promise<{ userCode: string }> => {
    return runConvex(
      Effect.gen(function* () {
        const user = yield* attempt(() =>
          ctx.runQuery(internal.workosIdentity.claimUser, {})
        )
        if (!claimAttemptToken || claimAttemptToken.length > 1000)
          return yield* Effect.fail(
            appError(
              "VALIDATION",
              "Supply the claim attempt from the agent's verification link."
            )
          )
        const rejected = yield* attempt(() =>
          ctx.runMutation(internal.workosIdentity.claimLimit, {
            userId: user.id,
            claimAttemptToken,
            ...(networkProof ? { networkProof } : {}),
          })
        )
        if (rejected) return yield* Effect.fail(appError("FORBIDDEN", rejected))
        const workos = yield* attemptSync(() => client())
        const result = yield* attempt(
          () =>
            workos.agents.linkClaimAttemptToExternalUser({
              claimAttemptToken,
              user: { email: user.email, externalId: user.id },
            }),
          (error) => {
            const known = externalError(error, "WorkOS")
            return known?.code === "BAD_GATEWAY"
              ? appError(
                  "VALIDATION",
                  "Could not claim this agent. Sign in with the email used for the claim and request a new claim link."
                )
              : known
          }
        )
        return { userCode: result.userCode }
      }),
      "workos_claim"
    )
  },
})
