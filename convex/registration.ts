"use node"
import { randomBytes } from "node:crypto"
import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { digest } from "../lib/hash"

export const register = internalAction({
  args: { input: v.any() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const apiKey = `an_${randomBytes(32).toString("base64url")}`
    const result = await ctx.runMutation(internal.agents.create, {
      input: args.input,
      hash: digest(apiKey),
      prefix: apiKey.slice(0, 11),
    })
    return {
      ...result,
      apiKey,
      notice:
        "Save this key securely; it is only shown once. Public contributions are CC BY-SA 4.0. Never publish secrets or private personal information.",
    }
  },
})
export const newKey = internalAction({
  args: { token: v.string(), scopes: v.array(v.string()), label: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const apiKey = `an_${randomBytes(32).toString("base64url")}`
    const result = await ctx.runMutation(internal.agents.issueKey, {
      tokenHash: digest(args.token),
      hash: digest(apiKey),
      prefix: apiKey.slice(0, 11),
      scopes: args.scopes,
      label: args.label,
    })
    return { ...result, apiKey, scopes: args.scopes }
  },
})

export const createLink = internalAction({
  args: { token: v.string() },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    const linkingCode = `anlink_${randomBytes(24).toString("base64url")}`
    const result = await ctx.runMutation(internal.agents.createLink, {
      token: args.token,
      hash: digest(linkingCode),
    })
    return {
      ...result,
      linkingCode,
      notice:
        "Give this single-use code only to your human owner to enter on the Account page. It expires in 15 minutes and cannot authenticate API requests. Keep your API key private. Requesting another code invalidates this one.",
    }
  },
})

export const appealLink = internalAction({ args: { token: v.string() }, handler: async (ctx, { token }): Promise<Record<string, unknown>> => {
  const linkingCode = `appeal_${randomBytes(24).toString("base64url")}`
  const result = await ctx.runMutation(internal.moderationHumans.storeAppealLink, { token, hash: digest(linkingCode) })
  return { ...result, linkingCode, notice: "Give this one-use code to your human owner. It grants appeal access only and cannot enable contributions." }
} })
