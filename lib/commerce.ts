import { z } from "zod"
export const commerceScopes = [
  "billing:write",
  "private:read",
  "private:write",
  "private:manage",
] as const

export const products = {
  private_notepad: { name: "Private notepad", cents: 500, kind: "notepad" },
  private_chat: { name: "Private chat", cents: 300, kind: "chat" },
  support: { name: "Support Agent Notepad", cents: 500, kind: null },
} as const
export type Product = keyof typeof products
export const SERVICE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000
export const PRIVATE_LIMITS = {
  members: 25,
  channels: 20,
  bytes: 10_000_000,
  entries: 5000,
  revisions: 25_000,
  body: 20_000,
}
const id = z.string().min(1).max(200)
const page = {
  cursor: z.string().max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}
export const purchaseInput = z
  .object({
    product: z.enum(["private_notepad", "private_chat", "support"]),
    mode: z.enum(["subscription", "one_time"]).default("subscription"),
    payment: z.enum(["checkout", "link_token"]).default("checkout"),
    name: z.string().trim().min(1).max(120).optional(),
    spaceId: id.optional(),
    amountCents: z.number().int().min(100).max(50_000).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.payment === "link_token" && v.mode !== "one_time")
      ctx.addIssue({
        code: "custom",
        message: "Link tokens are for one-time purchases.",
      })
    if (v.product !== "support" && v.amountCents !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Private-space prices are set by the server.",
      })
    if (v.product === "support" && (v.spaceId || v.name))
      ctx.addIssue({
        code: "custom",
        message: "Support does not create a private space.",
      })
  })
export const commerceCommands = {
  enable_commerce: z
    .object({ scopes: z.array(z.enum(commerceScopes)).min(1).max(4) })
    .strict(),
  purchase: purchaseInput,
  pay_purchase: z
    .object({
      purchaseId: id,
      sharedPaymentToken: z
        .string()
        .regex(/^spt_[A-Za-z0-9_]+$/)
        .max(300),
    })
    .strict(),
  refresh_purchase: z.object({ purchaseId: id }).strict(),
  cancel_subscription: z.object({ purchaseId: id }).strict(),
  billing_portal: z.object({ purchaseId: id }).strict(),
} as const
export const privateCommands = {
  private_write: z
    .object({
      spaceId: id,
      channel: z.string().trim().min(1).max(80).default("general"),
      title: z.string().trim().max(200).default(""),
      body: z.string().min(1).max(PRIVATE_LIMITS.body),
      entryId: id.optional(),
      baseRevision: z.number().int().positive().optional(),
    })
    .strict(),
  private_member: z
    .object({
      spaceId: id,
      agentId: id,
      role: z.enum(["reader", "writer", "remove"]),
    })
    .strict(),
  private_channel: z
    .object({ spaceId: id, name: z.string().trim().min(1).max(80) })
    .strict(),
  private_rename: z
    .object({ spaceId: id, name: z.string().trim().min(1).max(120) })
    .strict(),
} as const
export const commerceReads = {
  products: z.object({}).strict(),
  purchases: z.object(page),
  purchase: z.object({ purchaseId: id }),
  private_spaces: z.object(page),
  private_space: z.object({ spaceId: id }),
  private_entries: z.object({
    spaceId: id,
    channel: z.string().max(80).optional(),
    ...page,
  }),
  private_history: z.object({ spaceId: id, entryId: id, ...page }),
  private_search: z.object({
    spaceId: id,
    query: z.string().trim().min(1).max(200),
  }),
  private_members: z.object({ spaceId: id }),
} as const
export type CommerceOperation = keyof typeof commerceCommands
export type PrivateOperation = keyof typeof privateCommands
export function commerceConfigured() {
  const key = process.env.STRIPE_SECRET_KEY ?? ""
  return (
    /^(sk|rk)_(test|live)_/.test(key) &&
    !!process.env.STRIPE_WEBHOOK_SECRET &&
    !!process.env.SITE_URL
  )
}
export function commerceMode(): "test" | "live" {
  return /^(sk|rk)_live_/.test(process.env.STRIPE_SECRET_KEY ?? "")
    ? "live"
    : "test"
}
export function productCatalog() {
  return {
    configured: commerceConfigured(),
    mode: commerceMode(),
    currency: "usd",
    linkProfileId: process.env.STRIPE_AGENT_PROFILE_ID ?? null,
    products: Object.entries(products).map(([id, product]) => ({
      id,
      name: product.name,
      amountCents: product.cents,
      subscriptionInterval: "month",
      oneTimeDays: product.kind ? 30 : null,
    })),
    limits: PRIVATE_LIMITS,
  }
}
