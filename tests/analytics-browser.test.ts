import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { consentKey } from "../lib/analytics/consent"

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: vi.fn(),
  identify: vi.fn(),
  reset: vi.fn(),
  opt_out_capturing: vi.fn(),
  opt_in_capturing: vi.fn(),
  stopSessionRecording: vi.fn(),
  startSessionRecording: vi.fn(),
  set_config: vi.fn(),
  get_distinct_id: vi.fn(),
}))
vi.mock("posthog-js", () => ({ default: sdk }))
class MemoryStorage {
  getItem(key: string) {
    return (this as unknown as Record<string, string>)[key] ?? null
  }
  setItem(key: string, value: string) {
    Object.defineProperty(this, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  }
  removeItem(key: string) {
    delete (this as unknown as Record<string, unknown>)[key]
  }
}
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.stubEnv("NEXT_PUBLIC_APP_ENV", "test")
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_ENABLED", "true")
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_VERIFICATION", "true")
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN", "phc_verification_only_token")
  vi.stubEnv("NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED", "true")
  const windowTarget = new EventTarget()
  const local = new MemoryStorage(),
    session = new MemoryStorage()
  Object.assign(windowTarget, { localStorage: local, sessionStorage: session })
  vi.stubGlobal("window", windowTarget)
  vi.stubGlobal("localStorage", local)
  vi.stubGlobal("sessionStorage", session)
  vi.stubGlobal("document", { cookie: "" })
  vi.stubGlobal("location", {
    pathname: "/wiki",
    href: "https://agentnotepad.com/wiki",
  })
  sdk.init.mockReturnValue(sdk)
  sdk.get_distinct_id.mockReturnValue("anonymous-device")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it("does not initialize, create identifiers, or capture until consent; withdrawal clears queued and persisted data", async () => {
  const browser = await import("../lib/analytics/browser")
  browser.startAnalytics()
  browser.identifyHuman(null)
  browser.track("copy_completed", { surface: "instructions" })
  await Promise.resolve()
  expect(sdk.init).not.toHaveBeenCalled()
  expect(sdk.capture).not.toHaveBeenCalled()
  window.dispatchEvent(
    new CustomEvent("analytics-consent", {
      detail: { analytics: true, replay: true },
    })
  )
  await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce())
  browser.identifyHuman("owner1")
  browser.identifyHuman("owner1")
  expect(sdk.identify).toHaveBeenCalledExactlyOnceWith("human:owner1")
  browser.identifyHuman("owner2")
  expect(sdk.reset).toHaveBeenCalledOnce()
  browser.identifyHuman(null)
  expect(sdk.reset).toHaveBeenCalledTimes(2)
  localStorage.setItem("ph_test_posthog", "secret")
  localStorage.setItem(consentKey, "keep")
  window.dispatchEvent(
    new CustomEvent("analytics-consent", {
      detail: { analytics: false, replay: false },
    })
  )
  const sent = sdk.capture.mock.calls.length
  browser.track("copy_completed", { surface: "instructions" })
  expect(sdk.capture).toHaveBeenCalledTimes(sent)
  expect(localStorage.getItem("ph_test_posthog")).toBeNull()
  expect(localStorage.getItem(consentKey)).toBe("keep")
  expect(sdk.opt_out_capturing).toHaveBeenCalledOnce()
})
it("resets a persisted account before capturing after an expired or changed login", async () => {
  localStorage.setItem(
    consentKey,
    JSON.stringify({ version: 1, analytics: true, replay: false })
  )
  sdk.get_distinct_id.mockReturnValue("human:previous-account")
  const browser = await import("../lib/analytics/browser")
  browser.startAnalytics()
  browser.identifyHuman(null)
  browser.track("copy_completed", { surface: "instructions" })
  await vi.waitFor(() => expect(sdk.capture).toHaveBeenCalledOnce())
  expect(sdk.reset).toHaveBeenCalledOnce()
  expect(sdk.reset.mock.invocationCallOrder[0]).toBeLessThan(
    sdk.capture.mock.invocationCallOrder[0]
  )
  browser.identifyHuman("current-account")
  expect(sdk.identify).toHaveBeenCalledWith("human:current-account")
})

it("waits for auth resolution and preserves the same account's session on reload", async () => {
  localStorage.setItem(
    consentKey,
    JSON.stringify({ version: 1, analytics: true, replay: true })
  )
  sdk.get_distinct_id.mockReturnValue("human:current-account")
  const browser = await import("../lib/analytics/browser")
  browser.startAnalytics()
  await Promise.resolve()
  expect(sdk.init).not.toHaveBeenCalled()
  browser.identifyHuman("current-account")
  await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce())
  expect(sdk.reset).not.toHaveBeenCalled()
})

it("pins masking and sampling, stops before sensitive routes, and never forces a sampled-out session", async () => {
  localStorage.setItem(
    consentKey,
    JSON.stringify({ version: 1, analytics: true, replay: true })
  )
  const browser = await import("../lib/analytics/browser")
  browser.startAnalytics()
  browser.identifyHuman(null)
  await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce())
  const config = sdk.init.mock.calls[0][1]
  expect(config.session_recording).toMatchObject({
    sampleRate: 0.1,
    maskAllInputs: true,
    maskTextSelector: "*",
    maskAllElementAttributes: true,
    captureJsonLd: false,
    recordBody: false,
    recordHeaders: false,
    captureCanvas: { recordCanvas: false },
  })
  expect(
    config.session_recording.maskCapturedNetworkRequestFn({
      name: "?token=secret",
    })
  ).toBeNull()
  expect(sdk.startSessionRecording).toHaveBeenCalledWith()
  browser.updateReplay("/account/private/fixture")
  expect(sdk.set_config).toHaveBeenLastCalledWith({
    disable_session_recording: true,
  })
  expect(sdk.stopSessionRecording).toHaveBeenCalled()
  const result = config.before_send({
    event: "$pageview",
    properties: {
      environment: "verification",
      actor_type: "human",
      transport: "browser",
      $set: { email: "secret" },
    },
  })
  expect(JSON.stringify(result)).not.toContain("secret")
})
