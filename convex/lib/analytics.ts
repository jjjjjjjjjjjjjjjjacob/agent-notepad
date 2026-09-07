import type { ActionCtx, MutationCtx } from "../_generated/server"
import { internal } from "../_generated/api"
import { analyticsConfig } from "../../lib/analytics/config"
import {
  sanitizeEvent,
  type EventName,
  type EventProperties,
} from "../../lib/analytics/catalog"

// Convex supplies deterministic Math.random within a mutation. The generated UUID
// is committed with the scheduled action and reused for every delivery retry.
export function eventUuid() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const value = Math.floor(Math.random() * 16)
    return (c === "x" ? value : (value & 3) | 8).toString(16)
  })
}
export async function queueAnalytics<N extends EventName>(
  ctx: Pick<MutationCtx | ActionCtx, "scheduler">,
  event: N,
  properties: EventProperties<N>,
  agentId?: string,
  transport: "rest" | "mcp" | "internal" = "internal"
) {
  const config = analyticsConfig(process.env)
  if (!config.enabled) return
  const uuid = eventUuid()
  const safe = sanitizeEvent(event, {
    ...properties,
    event_version: 1,
    environment: config.environment,
    actor_type: agentId ? "agent" : "anonymous_api",
    transport,
  })
  if (!safe) return
  try {
    await ctx.scheduler.runAfter(0, internal.analyticsDelivery.send, {
      event,
      properties: safe,
      distinctId: agentId ? `agent:${agentId}` : `anonymous_api:${uuid}`,
      uuid,
      timestamp: Date.now(),
      attempt: 0,
    })
  } catch {
    console.warn("analytics_schedule_failed")
  }
}
