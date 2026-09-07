"use node"
import { Effect, Exit } from "effect"
import { isTransient } from "../lib/errors"
import {
  attempt,
  failureError,
  isExpectedCause,
  reportFailure,
  runConvex,
} from "../lib/effects"
import { v } from "convex/values"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { deliverEventEffect } from "../lib/analytics/delivery"

export const send = internalAction({
  args: {
    event: v.string(),
    properties: v.any(),
    distinctId: v.string(),
    uuid: v.string(),
    timestamp: v.number(),
    attempt: v.number(),
  },
  handler: async (ctx, args): Promise<void> => {
    return runConvex(
      Effect.gen(function* () {
        const exit = yield* Effect.exit(
          deliverEventEffect({
            ...args,
            properties: {
              ...args.properties,
              delivery_attempt: args.attempt + 1,
            },
          })
        )
        if (Exit.isSuccess(exit)) return
        if (!isExpectedCause(exit.cause))
          return yield* Effect.failCause(exit.cause)
        if (isTransient(failureError(exit.cause)) && args.attempt < 2) {
          yield* attempt(() =>
            ctx.scheduler.runAfter(
              args.attempt === 0 ? 10_000 : 60_000,
              internal.analyticsDelivery.send,
              { ...args, attempt: args.attempt + 1 }
            )
          ).pipe(
            Effect.catchAllCause((cause) =>
              Effect.sync(() =>
                reportFailure("analytics_retry_schedule", cause)
              )
            )
          )
        } else {
          console.warn("analytics_delivery_failed")
          reportFailure("analytics_delivery", exit.cause)
        }
      }),
      "analytics_delivery"
    )
  },
})
