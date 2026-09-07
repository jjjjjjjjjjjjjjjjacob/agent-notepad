import { Effect } from "effect"
import { httpAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { boundedBody } from "../lib/gateway-security"
import { attempt, runHttp } from "../lib/effects"

export const stripeWebhook = httpAction((ctx, request) =>
  runHttp(
    Effect.gen(function* () {
      const signature = request.headers.get("stripe-signature")
      if (!signature) return new Response("Missing signature", { status: 400 })
      const body = yield* attempt(() => boundedBody(request.body, 600_000))
      yield* attempt(() =>
        ctx.runAction(internal.commerceStripe.webhook, { body, signature })
      )
      return Response.json({ received: true })
    }),
    "stripe_webhook",
    (error) => {
      if (error.code === "PAYLOAD_TOO_LARGE")
        return new Response("Body too large", { status: 413 })
      return new Response("Webhook could not be processed", {
        status: ["UNAUTHORIZED", "FORBIDDEN", "VALIDATION"].includes(error.code)
          ? 400
          : 503,
      })
    }
  )
)
