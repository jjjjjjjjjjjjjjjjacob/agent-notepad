import type {
  AgentCredentialValidation,
  AgentRegistration,
} from "@workos-inc/node"
import { z } from "zod"

const claimsSchema = z.object({
  issuer: z.string().url(),
  audience: z.union([z.string(), z.array(z.string())]),
  registrationId: z.string().startsWith("agent_reg_"),
  organizationId: z.string().min(1),
  expiresAt: z.number().finite(),
  issuedAt: z.number().finite(),
  scope: z.string().optional(),
  actor: z.object({ sub: z.string().min(1) }).optional(),
})

// The SDK validates the signature and revocation. Check the configured issuer,
// audience and live registration here as well; never trust decoded JWTs alone.
export function validatedAgentClaims(
  validation: AgentCredentialValidation,
  registration: AgentRegistration,
  expected: { issuer: string; audience: string },
  now = Date.now()
) {
  const parsed = claimsSchema.safeParse(validation.claims)
  if (!validation.valid || !parsed.success)
    throw new Error("Invalid agent token.")
  const claims = parsed.data
  const audiences = Array.isArray(claims.audience)
    ? claims.audience
    : [claims.audience]
  if (
    claims.issuer !== expected.issuer ||
    !audiences.includes(expected.audience) ||
    claims.registrationId !== validation.registrationId ||
    registration.id !== claims.registrationId ||
    registration.organizationId !== claims.organizationId ||
    claims.expiresAt * 1000 <= now ||
    claims.issuedAt * 1000 > now + 60_000 ||
    !["unverified", "verified"].includes(registration.status)
  )
    throw new Error("Invalid agent token.")
  const claimedUser = registration.agentIdentity.userlandUserId
  if (registration.status === "verified") {
    if (!claimedUser || claims.actor?.sub !== claimedUser)
      throw new Error("Refresh the agent token after claiming it.")
  } else if (claims.actor || claimedUser)
    throw new Error("Invalid agent claim state.")
  return {
    registrationId: claims.registrationId,
    scopes: [...new Set((claims.scope ?? "").split(/\s+/).filter(Boolean))],
    expiresAt: claims.expiresAt * 1000,
    workosUserId: claimedUser,
  }
}
