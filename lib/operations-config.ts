import { z } from "zod"
import type { Environment } from "./environment"

export function supportEmail(env: Environment = process.env) {
  const value = env.PUBLIC_SUPPORT_EMAIL?.trim()
  return value ? z.email().parse(value) : null
}

export function validateProductionOperations(env: Environment = process.env) {
  if (!supportEmail(env))
    throw new Error(
      "PUBLIC_SUPPORT_EMAIL is required for production support and takedowns."
    )
  if (env.WRITE_GATEWAY_REQUIRED !== "true")
    throw new Error("Production requires the signed write gateway.")
  for (const name of [
    "MODERATION_GATEWAY_SECRET",
    "MODERATION_IP_SECRET",
  ] as const)
    if (!/^[a-f0-9]{64}$/i.test(env[name] ?? ""))
      throw new Error(`${name} must be a 32-byte hex secret.`)
}
