"use client"
import type { PostHog } from "posthog-js"
import { analyticsConfig } from "./config"
import {
  clearAnalyticsStorage,
  consentKey,
  declined,
  readConsent,
  type Consent,
} from "./consent"
import {
  replayAllowed,
  routeName,
  safeUrl,
  sanitizeEvent,
  type EventName,
  type EventProperties,
} from "./catalog"
import {
  privateSelector,
  replayBlockSelector,
  sanitizeBrowserCapture,
} from "./privacy"

export const browserConfig = analyticsConfig(
  {
    NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
    NEXT_PUBLIC_POSTHOG_ENABLED: process.env.NEXT_PUBLIC_POSTHOG_ENABLED,
    NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN:
      process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN,
    NEXT_PUBLIC_POSTHOG_HOST: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED:
      process.env.NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED,
    NEXT_PUBLIC_POSTHOG_VERIFICATION:
      process.env.NEXT_PUBLIC_POSTHOG_VERIFICATION,
  },
  true
)
let client: PostHog | undefined
let loading: Promise<void> | undefined
let consent: Consent = declined
let started = false
let humanId: string | null = null
let identityReady = false
let identifiedId: string | null = null
let viewId: string | undefined
let route = "/"
let generation = 0
let pending: (() => void)[] = []

export function analyticsEnabled() {
  return browserConfig.enabled && consent.analytics
}
export function setViewContext(id: string, pathname: string) {
  viewId = id
  route = routeName(pathname)
}
export function track<N extends EventName>(
  event: N,
  properties: EventProperties<N>,
  immediate = false
) {
  if (!analyticsEnabled()) return
  const data = sanitizeEvent(event, {
    ...properties,
    event_version: 1,
    environment: browserConfig.environment,
    actor_type: "human",
    transport: "browser",
    route,
    ...(viewId ? { view_id: viewId } : {}),
  })
  if (!data) return
  const send = () => {
    try {
      if (analyticsEnabled())
        client?.capture(
          event,
          data,
          immediate
            ? { send_instantly: true, transport: "sendBeacon" }
            : undefined
        )
    } catch {
      /* analytics must not affect the app */
    }
  }
  if (client) send()
  else if (pending.length < 50) pending.push(send)
}
export function identifyHuman(id: string | null) {
  humanId = id
  identityReady = true
  if (!client) {
    if (started && analyticsEnabled()) void initialize()
    return
  }
  if (!analyticsEnabled() || identifiedId === id) return
  if (identifiedId) client.reset()
  if (id) client.identify(`human:${id}`)
  identifiedId = id
}
export function pauseReplay() {
  client?.stopSessionRecording()
}
export function updateReplay(pathname: string) {
  if (!client) return
  const allowed =
    analyticsEnabled() &&
    consent.replay &&
    browserConfig.replay &&
    replayAllowed(pathname)
  client.set_config({ disable_session_recording: !allowed })
  if (allowed)
    client.startSessionRecording() // No override: retains deterministic 10% session sampling.
  else client.stopSessionRecording()
}
async function initialize() {
  if (client || loading || !analyticsEnabled() || !identityReady) return loading
  const version = generation
  loading = (async () => {
    const { default: posthog } = await import("posthog-js")
    if (!analyticsEnabled() || version !== generation) return
    const instance = posthog.init(browserConfig.token, {
      api_host: browserConfig.host,
      ui_host: "https://us.posthog.com",
      defaults: "2026-08-30",
      persistence: "localStorage",
      cross_subdomain_cookie: false,
      person_profiles: "identified_only",
      get_current_url: () => safeUrl(location.href, location.href),
      save_campaign_params: false,
      save_referrer: false,
      capture_pageview: false,
      capture_pageleave: false,
      capture_exceptions: false,
      capture_performance: false,
      capture_heatmaps: false,
      capture_dead_clicks: false,
      rageclick: false,
      disable_surveys: true,
      enable_recording_console_log: false,
      advanced_disable_feature_flags: true,
      mask_all_text: true,
      mask_all_element_attributes: true,
      autocapture: {
        dom_event_allowlist: ["click"],
        element_allowlist: ["a", "button"],
        css_selector_allowlist: ["[data-analytics-control]"],
        css_selector_ignorelist: [
          privateSelector,
          ".ph-no-autocapture",
          "[data-ph-no-autocapture]",
        ],
        capture_copied_text: false,
      },
      disable_session_recording: true,
      session_recording: {
        sampleRate: 0.1,
        maskAllInputs: true,
        maskTextSelector: "*",
        maskAllElementAttributes: true,
        blockSelector: replayBlockSelector,
        recordHeaders: false,
        recordBody: false,
        streamNetworkBody: false,
        recordCrossOriginIframes: false,
        captureCanvas: { recordCanvas: false },
        captureJsonLd: false,
        collectFonts: false,
        maskCapturedNetworkRequestFn: () => null,
      },
      before_send: (result) => {
        if (!result || !analyticsEnabled()) return null
        if (
          result.event === "$snapshot" &&
          (!consent.replay ||
            !browserConfig.replay ||
            !replayAllowed(location.pathname))
        )
          return null
        return sanitizeBrowserCapture(result, location.href, {
          environment: browserConfig.environment,
          ...(viewId ? { view_id: viewId } : {}),
        })
      },
    })
    client = instance
    // A prior account may remain in SDK persistence after logout in another tab
    // or an expired authentication session. Reconcile before any queued events.
    const persistedId = client?.get_distinct_id()
    identifiedId = persistedId?.startsWith("human:")
      ? persistedId.slice(6)
      : null
    identifyHuman(humanId)
    updateReplay(location.pathname)
    const events = pending
    pending = []
    events.forEach((send) => send())
    window.dispatchEvent(new Event("analytics-ready"))
  })()
    .catch(() => {
      pending = []
      console.warn("analytics_initialization_failed")
    })
    .finally(() => {
      loading = undefined
      if (version !== generation && analyticsEnabled() && !client)
        void initialize()
    })
  return loading
}
function applyConsent(next: Consent) {
  consent = next
  if (!next.analytics) {
    generation++
    pending = []
    client?.stopSessionRecording()
    client?.opt_out_capturing()
    client?.reset()
    identifiedId = null
    clearAnalyticsStorage()
  } else if (client) {
    client.opt_in_capturing({ captureEventName: false })
    identifyHuman(humanId)
    updateReplay(location.pathname)
  } else void initialize()
}
export function startAnalytics() {
  if (started || !browserConfig.enabled) return
  started = true
  consent = readConsent() ?? declined
  if (!consent.analytics) clearAnalyticsStorage()
  window.addEventListener("analytics-consent", (e) =>
    applyConsent((e as CustomEvent<Consent>).detail)
  )
  window.addEventListener("storage", (e) => {
    if (e.key === consentKey || e.key === null)
      window.dispatchEvent(
        new CustomEvent("analytics-consent", {
          detail: readConsent() ?? declined,
        })
      )
  })
  window.addEventListener("error", () =>
    track("application_error", {
      error_code: "unhandled_error",
      source: "browser",
    })
  )
  window.addEventListener("unhandledrejection", () =>
    track("application_error", {
      error_code: "unhandled_rejection",
      source: "promise",
    })
  )
  void initialize()
}
