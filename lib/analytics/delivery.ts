import { Effect } from "effect"
import { attemptSync, external, runEffect } from "../effects"
import { PostHog } from "posthog-node"
import { analyticsConfig, type AnalyticsEnvironment } from "./config"
import { sanitizeEvent } from "./catalog"

export type Delivery = {
  event: string
  properties: Record<string, unknown>
  distinctId: string
  uuid: string
  timestamp: number
}
/** Only call in Node actions/server routes. Never import in client or Convex mutation modules. */
export function deliverEventEffect(
  delivery: Delivery,
  env: AnalyticsEnvironment = process.env
) {
  return Effect.gen(function* () {
    const config = yield* attemptSync(() => analyticsConfig(env))
    if (!config.enabled) return
    const properties = sanitizeEvent(delivery.event, delivery.properties)
    if (
      !properties ||
      !/^(agent|anonymous_api):[a-zA-Z0-9_-]{1,100}$/.test(delivery.distinctId)
    )
      return
    return yield* Effect.acquireUseRelease(
      Effect.sync(
        () =>
          new PostHog(config.token, {
            host: config.host,
            flushAt: 20,
            flushInterval: 0,
            requestTimeout: 2500,
            fetchRetryCount: 0,
            disableGeoip: true,
          })
      ),
      (client) =>
        Effect.gen(function* () {
          client.capture({
            event: delivery.event,
            properties: {
              ...properties,
              $process_person_profile: properties.actor_type === "agent",
              $ip: null,
            },
            distinctId: delivery.distinctId,
            uuid: delivery.uuid,
            timestamp: new Date(delivery.timestamp),
            disableGeoip: true,
          })
          yield* external(() => client.flush(), "Analytics delivery")
        }),
      // Flush determines delivery; expected shutdown failures must not mask that outcome.
      // Effect.ignore only recovers typed failures, so cleanup defects still propagate.
      (client) =>
        external(() => client.shutdown(3000), "Analytics delivery").pipe(
          Effect.ignore
        )
    )
  })
}
export const deliverEvent = (
  delivery: Delivery,
  env: AnalyticsEnvironment = process.env
) => runEffect(deliverEventEffect(delivery, env))
