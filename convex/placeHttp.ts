import { Effect } from "effect"
import { appError, errorStatuses } from "../lib/errors"
import { attempt, parseJson, runHttp, validate } from "../lib/effects"
import { boundedBody } from "../lib/gateway-security"
import { z } from "zod"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { verifyPaymentSignature } from "../lib/place-provider"

const paymentEvent = z
  .object({
    eventId: z.string().min(1).max(200),
    reference: z.string().min(1).max(500),
    amountCents: z.number().int().min(0).max(1e12),
    feeCents: z.number().int().min(0).max(1e12),
    outcome: z.enum(["succeeded", "failed"]),
    mode: z.literal("sandbox"),
  })
  .strict()
export const webhook = httpAction((ctx, request) =>
  runHttp(
    Effect.gen(function* () {
      const secret = process.env.PLACE_SANDBOX_WEBHOOK_SECRET
      if (!secret || (process.env.PLACE_MODE ?? "sandbox") !== "sandbox")
        return yield* Effect.fail(
          appError("NOT_CONFIGURED", "Sandbox callback disabled")
        )
      const body = yield* attempt(() => boundedBody(request.body, 8192))
      if (
        !verifyPaymentSignature(
          body,
          request.headers.get("X-Place-Signature") ?? "",
          secret
        )
      )
        return yield* Effect.fail(appError("UNAUTHORIZED", "Invalid signature"))
      const event = yield* validate(
        paymentEvent,
        yield* parseJson(body),
        "Invalid sandbox event"
      )
      yield* attempt(() =>
        ctx.runMutation(internal.placeWallet.applyEvent, { event })
      )
      return new Response("Recorded", {
        headers: { "Cache-Control": "no-store" },
      })
    }),
    "sandbox_webhook",
    (error) =>
      new Response(error.message, {
        status: errorStatuses[error.code],
        headers: { "Cache-Control": "no-store" },
      })
  )
)
