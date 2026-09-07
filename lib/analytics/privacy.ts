import type { CaptureResult } from "posthog-js"
import { routeName, safeUrl, sanitizeEvent } from "./catalog"

const sdkKeys = new Set([
  "token",
  "distinct_id",
  "$device_id",
  "$session_id",
  "$window_id",
  "$anon_distinct_id",
  "$is_identified",
  "$process_person_profile",
  "$lib",
  "$lib_version",
  "$browser",
  "$browser_version",
  "$os",
  "$os_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$event_type",
  "$snapshot_bytes",
  "$snapshot_data",
  "$snapshot_source",
  "$session_recording_start_reason",
])
/** Last boundary before SDK-added URLs, titles, person properties, or DOM text leave the browser. */
export function sanitizeBrowserCapture(
  result: CaptureResult,
  base: string,
  context: { environment: "production" | "verification"; view_id?: string } = {
    environment: "verification",
  }
): CaptureResult | null {
  const sdkEvent = [
    "$identify",
    "$create_alias",
    "$autocapture",
    "$snapshot",
  ].includes(result.event)
  const parsed = sdkEvent
    ? {
        ...context,
        event_version: 1,
        actor_type: "human",
        transport: "browser",
        route: routeName(new URL(base).pathname),
      }
    : sanitizeEvent(result.event, result.properties)
  if (!parsed) return null
  const properties: Record<string, unknown> = { ...parsed }
  for (const [key, value] of Object.entries(result.properties)) {
    if (sdkKeys.has(key)) properties[key] = value
  }
  // Snapshot payloads have their own input/text/attribute masks and URL callback.
  // Never preserve arbitrary $set/$set_once, DOM elements, exception text, or titles.
  const route = parsed.route ?? routeName(new URL(base).pathname)
  properties.$current_url = safeUrl(`${new URL(base).origin}${route}`, base)
  properties.$pathname = route
  properties.$ip = null
  properties.$geoip_disable = true
  return {
    uuid: result.uuid,
    event: result.event,
    properties,
    ...(result.timestamp ? { timestamp: result.timestamp } : {}),
  }
}

export const privateSelector = "[data-analytics-private], .ph-no-capture"
export const replayBlockSelector = `${privateSelector}, img, picture, video, audio, canvas, iframe, pre, code, input[type=hidden], input[type=file]`
