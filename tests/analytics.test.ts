import { describe, expect, it } from "vitest"
import {
  analyticsConfig,
  validateAnalyticsEnvironment,
} from "../lib/analytics/config"
import { parseConsent } from "../lib/analytics/consent"
import {
  replayAllowed,
  routeName,
  safeUrl,
  sanitizeEvent,
} from "../lib/analytics/catalog"
import { sanitizeBrowserCapture } from "../lib/analytics/privacy"
import type { CaptureResult } from "posthog-js"

const context = {
  environment: "verification",
  actor_type: "human",
  transport: "browser",
}
describe("analytics privacy boundaries", () => {
  it("removes payload text and rejects unknown events", () => {
    const properties = sanitizeEvent("search_submitted", {
      ...context,
      search_id: crypto.randomUUID(),
      surface: "page",
      query_length: 12,
      query: "a private query",
      token: "secret",
      email: "secret@example.com",
    })
    expect(properties).toMatchObject({ query_length: 12, event_version: 1 })
    expect(JSON.stringify(properties)).not.toMatch(/private|secret|email/)
    expect(sanitizeEvent("whatever", context)).toBeNull()
    expect(
      sanitizeEvent("search_submitted", { ...context, query_length: -1 })
    ).toBeNull()
  })
  it("drops SDK person properties, dynamic titles, DOM attributes, and URL secrets", () => {
    const captured = sanitizeBrowserCapture(
      {
        uuid: crypto.randomUUID(),
        event: "$pageview",
        $set_once: { secret: "private_person_field" },
        properties: {
          ...context,
          token: "phc_public_project_key",
          distinct_id: "human:test",
          $current_url: "https://agentnotepad.com/search?q=secret",
          $referrer: "https://example.com/?token=secret",
          $set_once: { $initial_current_url: "?q=secret" },
          $set: { email: "secret@example.com" },
          $title: "secret",
          $elements: [{ text: "secret" }],
        },
      } as CaptureResult,
      "https://agentnotepad.com/search?q=secret#secret"
    )
    expect(captured?.properties.$current_url).toBe(
      "https://agentnotepad.com/search"
    )
    expect(captured?.properties.token).toBe("phc_public_project_key")
    expect(captured?.properties.distinct_id).toBe("human:test")
    expect(JSON.stringify(captured)).not.toContain("secret")
    expect(JSON.stringify(captured)).not.toContain("private_person_field")
    expect(captured?.properties.$ip).toBeNull()
  })
  it("never sends user-selected path segments or non-http URLs", () => {
    expect(safeUrl("/wiki/an_secret?query=private#private")).toBe(
      "https://agentnotepad.com/wiki/[detail]"
    )
    expect(safeUrl("https://example.com/secret?token=private")).toBe(
      "https://example.com"
    )
    expect(safeUrl("mailto:private@example.com")).toBe("")
    expect(routeName("/account/agents/secret/chat")).toBe("/account/[detail]")
    for (const path of [
      "/account",
      "/account/private/fixture",
      "/account/agents/secret/chat",
      "/reviews/secret",
      "/unknown",
    ])
      expect(replayAllowed(path)).toBe(false)
    expect(replayAllowed("/wiki/capybara")).toBe(true)
  })
  it("requires explicit versioned consent and prevents replay-only consent", () => {
    for (const raw of [
      null,
      "garbage",
      "{}",
      '{"version":2,"analytics":true,"replay":true}',
    ])
      expect(parseConsent(raw)).toBeNull()
    expect(
      parseConsent('{"version":1,"analytics":false,"replay":true}')
    ).toEqual({ analytics: false, replay: false })
  })
})
describe("analytics environments", () => {
  const configured = {
    POSTHOG_ENABLED: "true",
    POSTHOG_PROJECT_TOKEN: "phc_verification_only_token",
    APP_ENV: "production",
  }
  it("requires production or explicit isolated verification", () => {
    expect(analyticsConfig({}).enabled).toBe(false)
    expect(analyticsConfig(configured).enabled).toBe(true)
    expect(
      analyticsConfig({ ...configured, VERCEL_ENV: "preview" }).enabled
    ).toBe(false)
    expect(analyticsConfig({ ...configured, APP_ENV: "test" }).enabled).toBe(
      false
    )
    expect(
      analyticsConfig({
        ...configured,
        APP_ENV: "test",
        POSTHOG_VERIFICATION: "true",
      })
    ).toMatchObject({ enabled: true, environment: "verification" })
  })
  it("rejects invalid enablement, host, and tokens", () => {
    expect(() =>
      validateAnalyticsEnvironment({ POSTHOG_ENABLED: "yes" })
    ).toThrow()
    expect(() =>
      validateAnalyticsEnvironment({ POSTHOG_ENABLED: "true" })
    ).toThrow()
    expect(() =>
      validateAnalyticsEnvironment({
        ...configured,
        POSTHOG_HOST: "https://evil.example",
      })
    ).toThrow()
    expect(
      analyticsConfig({ ...configured, POSTHOG_HOST: "https://evil.example" })
        .enabled
    ).toBe(false)
  })
})
