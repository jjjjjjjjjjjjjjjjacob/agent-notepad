import { z } from "zod"
import {
  DEFAULT_DURATION,
  MAX_BUNDLE_PIXELS,
  MAX_DURATION,
  MAX_MONEY,
  MAX_PAINT_PIXELS,
  MIN_DURATION,
} from "./place"
const id = z.string().min(1).max(200)
const cents = z.number().int().min(1).max(MAX_MONEY)
const duration = z
  .number()
  .int()
  .min(MIN_DURATION)
  .max(MAX_DURATION)
  .default(DEFAULT_DURATION)
const pixel = z.number().int().min(0).max(999999)
const shares = z
  .array(
    z
      .object({ agentId: id, weight: z.number().int().min(1).max(1_000_000) })
      .strict()
  )
  .min(1)
  .max(128)
export const placeCommandSchemas = {
  place_create: z
    .object({
      kind: z.enum([
        "initial",
        "buy_now",
        "auction",
        "offer",
        "transfer",
        "forfeiture",
      ]),
      title: z.string().trim().min(1).max(160),
      pixelCount: z.number().int().min(1).max(MAX_BUNDLE_PIXELS),
      priceCents: cents.optional(),
      durationMs: duration,
      buyerId: id.optional(),
      lotId: id.optional(),
    })
    .strict(),
  place_append: z
    .object({ dealId: id, pixels: z.array(pixel).min(1).max(500) })
    .strict(),
  place_seal: z.object({ dealId: id, shares: shares.optional() }).strict(),
  place_terms: z
    .object({
      dealId: id,
      priceCents: cents.optional(),
      durationMs: duration.optional(),
      shares: shares.optional(),
    })
    .strict(),
  place_approve: z
    .object({ dealId: id, termsHash: z.string().min(1).max(128) })
    .strict(),
  place_buy: z
    .object({ dealId: id, termsHash: z.string().min(1).max(128) })
    .strict(),
  place_bid: z.object({ dealId: id, amountCents: cents }).strict(),
  place_cancel: z.object({ dealId: id }).strict(),
  place_paint: z
    .object({
      pixels: z
        .array(
          z.object({ pixel, color: z.number().int().min(0).max(15) }).strict()
        )
        .min(1)
        .max(MAX_PAINT_PIXELS),
    })
    .strict(),
  place_allocate: z
    .object({ agentId: id, fromAgentId: id.optional(), amountCents: cents })
    .strict(),
  place_watch: z
    .object({ dealId: id, enabled: z.boolean().default(true) })
    .strict(),
  integrity_flag: z
    .object({
      resourceId: id,
      agentId: id,
      reason: z.string().trim().min(10).max(4000),
    })
    .strict(),
} as const
export type PlaceOperation = keyof typeof placeCommandSchemas
export type PlaceInput<T extends PlaceOperation> = z.infer<
  (typeof placeCommandSchemas)[T]
>
export const placeReadSchemas = {
  place_config: z.object({}),
  place_tiles: z.object({
    tiles: z
      .string()
      .regex(/^\d+(,\d+)*$/)
      .default("210"),
  }),
  place_pixel: z.object({ pixel: z.coerce.number().int().min(0).max(999999) }),
  place_deal: z.object({
    id,
    chunk: z.coerce.number().int().min(0).max(19).optional(),
  }),
  place_market: z.object({
    kind: z.enum(["buy_now", "auction", "offer", "forfeiture"]).optional(),
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
  place_history: z.object({
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(25),
  }),
  place_portfolio: z.object({
    agentId: id,
    after: z.coerce.number().int().min(-1).max(999999).default(-1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
  place_wallet: z.object({}),
  integrity_evidence: z.object({
    reviewId: id,
    cursor: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(32).default(16),
  }),
} as const
