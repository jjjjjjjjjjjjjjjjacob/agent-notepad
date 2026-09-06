"use node"
import { WorkOS } from "@workos-inc/node"
import { v, ConvexError } from "convex/values"
import { action, internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { fail } from "./lib/core"
import { validatedAgentClaims } from "../lib/workos-agent"
import type { WorkosPrincipal } from "./lib/agentIdentity"

function client() {
  if (
    !process.env.WORKOS_API_KEY ||
    !process.env.WORKOS_CLIENT_ID ||
    !process.env.WORKOS_AUTHKIT_ISSUER
  )
    fail("NOT_CONFIGURED", "WorkOS Agent Registration is not configured.")
  return new WorkOS(process.env.WORKOS_API_KEY, {
    clientId: process.env.WORKOS_CLIENT_ID,
    timeout: 10_000,
    maxRetries: 1,
  })
}

export const authenticate = internalAction({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<WorkosPrincipal> => {
    if (!token || token.length > 16_384 || token.split(".").length !== 3)
      fail("UNAUTHORIZED", "Supply a WorkOS agent access token.")
    const workos = client()
    try {
      const validation = await workos.agents.validateCredential({
        type: "access_token",
        credential: token,
        audience:
          process.env.WORKOS_AGENT_AUDIENCE ?? process.env.WORKOS_CLIENT_ID!,
        checkForRevoked: true,
      })
      if (!validation.valid)
        fail("UNAUTHORIZED", "Agent token is invalid, expired, or revoked.")
      const registration = await workos.agents.getRegistration(
        validation.registrationId
      )
      const checked = validatedAgentClaims(validation, registration, {
        issuer: process.env.WORKOS_AUTHKIT_ISSUER!,
        audience:
          process.env.WORKOS_AGENT_AUDIENCE ?? process.env.WORKOS_CLIENT_ID!,
      })
      // Ownership comes from the verified WorkOS user, never an email or ID sent by an agent.
      const ownerId = checked.workosUserId
        ? (await workos.userManagement.getUser(checked.workosUserId)).externalId
        : null
      const identity: WorkosPrincipal = {
        registrationId: checked.registrationId,
        scopes: checked.scopes,
        expiresAt: checked.expiresAt,
        ...(ownerId ? { ownerId } : {}),
      }
      if (checked.workosUserId && !ownerId)
        fail("FORBIDDEN", "Claim this agent through this app's account page.")
      await ctx.runMutation(internal.workosIdentity.provision, { identity })
      return identity
    } catch (error) {
      // Keep provider errors (which may include credentials/request details) out of responses/logs.
      if (error instanceof ConvexError) throw error
      fail(
        "UNAUTHORIZED",
        "WorkOS could not validate this agent token. Refresh it and retry."
      )
    }
  },
})

export const claim = action({
  args: { claimAttemptToken: v.string(), networkProof: v.optional(v.any()) },
  handler: async (
    ctx,
    { claimAttemptToken, networkProof }
  ): Promise<{ userCode: string }> => {
    const user = await ctx.runQuery(internal.workosIdentity.claimUser, {})
    if (!claimAttemptToken || claimAttemptToken.length > 1000)
      fail(
        "VALIDATION",
        "Supply the claim attempt from the agent's verification link."
      )
    const rejected = await ctx.runMutation(internal.workosIdentity.claimLimit, {
      userId: user.id, claimAttemptToken, ...(networkProof ? { networkProof } : {}),
    })
    if (rejected) fail("FORBIDDEN", rejected)
    try {
      const result = await client().agents.linkClaimAttemptToExternalUser({
        claimAttemptToken,
        user: { email: user.email, externalId: user.id },
      })
      return { userCode: result.userCode }
    } catch {
      fail(
        "VALIDATION",
        "Could not claim this agent. Sign in with the email used for the claim and request a new claim link."
      )
    }
  },
})
