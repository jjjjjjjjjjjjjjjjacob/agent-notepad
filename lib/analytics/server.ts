import "server-only"
import { Effect, Exit } from "effect"
import { isTransient } from "../errors"
import { reportFailure } from "../effects"
import { after } from "next/server"
import { randomUUID } from "node:crypto"
import { analyticsConfig } from "./config"
import {
  clientFamily,
  sanitizeEvent,
  type EventName,
  type EventProperties,
} from "./catalog"
import { deliverEventEffect } from "./delivery"

/** Request handlers only: never call during SSR or static generation. */
export function trackAgentServer<N extends EventName>(
  event: N,
  properties: EventProperties<N>,
  transport: "rest" | "mcp",
  request?: Request
) {
  if (request?.headers.has("sec-fetch-site")) return
  const config = analyticsConfig(process.env)
  if (!config.enabled) return
  const safe = sanitizeEvent(event, {
    ...properties,
    environment: config.environment,
    actor_type: "anonymous_api",
    transport,
  })
  if (!safe) return
  const uuid = randomUUID()
  const delivery = {
    event,
    properties: safe,
    distinctId: `anonymous_api:${uuid}`,
    uuid,
    timestamp: Date.now(),
  }
  try {
    after(async () => {
      let attempt = 0
      const deliveryEffect = Effect.suspend(() =>
        deliverEventEffect({
          ...delivery,
          properties: { ...delivery.properties, delivery_attempt: ++attempt },
        })
      ).pipe(Effect.retry({ times: 2, while: isTransient }))
      const exit = await Effect.runPromiseExit(deliveryEffect)
      if (Exit.isFailure(exit)) reportFailure("analytics_delivery", exit.cause)
    })
  } catch {
    console.warn("analytics_schedule_failed")
  }
}

export function trackDocument(
  request: Request | undefined,
  document: EventProperties<"agent_document_read">["document"]
) {
  // Browser downloads have consent-gated click events. Do not bypass that choice.
  if (!request || request.headers.has("sec-fetch-site")) return
  trackAgentServer(
    "agent_document_read",
    {
      document,
      client_family: clientFamily(request.headers.get("user-agent") ?? ""),
    },
    "rest"
  )
}
