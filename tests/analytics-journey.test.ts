import { afterEach, beforeEach, expect, it, vi } from "vitest"

const browser = vi.hoisted(() => ({
  analyticsEnabled: vi.fn(() => true),
  track: vi.fn(),
  setViewContext: vi.fn(),
  updateReplay: vi.fn(),
}))
vi.mock("../lib/analytics/browser", () => browser)
let now = 0
const visibility = { hidden: false, referrer: "", querySelector: () => null }
beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  now = 0
  visibility.hidden = false
  vi.stubGlobal("performance", { now: () => now })
  vi.stubGlobal("document", visibility)
  vi.stubGlobal("location", new URL("https://agentnotepad.com/wiki/example"))
})
afterEach(() => vi.unstubAllGlobals())

it("keeps simultaneous search surfaces separate and consumes only matching sanitized metadata", async () => {
  const values = new Map<string, string>()
  vi.stubGlobal("sessionStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  })
  const journey = await import("../lib/analytics/journey")
  journey.beginSearch({
    surface: "channel_navigation",
    query_length: 7,
    query: "do-not-persist",
  } as never)
  expect(JSON.stringify([...values.values()])).not.toContain("do-not-persist")
  const submitted = browser.track.mock.calls.find(
    ([name]) => name === "search_submitted"
  )![1]
  const properties = {
    query_length: 7,
    result_count: 1,
    mode: "keyword" as const,
    duration_ms: 3,
  }
  journey.searchResults(properties)
  journey.searchResults({ ...properties, surface: "channel_navigation" })
  journey.resultClicked(1, "channel-id", undefined, "channel_navigation")
  const results = browser.track.mock.calls.filter(
    ([name]) => name === "search_results_viewed"
  )
  expect(results).toHaveLength(2)
  expect(results[0][1].search_id).not.toBe(submitted.search_id)
  expect(results[1][1].search_id).toBe(submitted.search_id)
  expect(browser.track).toHaveBeenLastCalledWith("search_result_clicked", {
    search_id: submitted.search_id,
    rank: 1,
    resource_id: "channel-id",
  })
})

it("assigns a new correlation ID to each completed local search without adding page views", async () => {
  const journey = await import("../lib/analytics/journey")
  journey.localSearch({ query_length: 3, result_count: 12, duration_ms: 1 })
  const first = journey.searchCorrelation("map")
  journey.localSearch({ query_length: 8, result_count: 0, duration_ms: 1 })
  expect(journey.searchCorrelation("map")).not.toBe(first)
  expect(
    browser.track.mock.calls.filter(([name]) => name === "$pageview")
  ).toHaveLength(1)
  expect(
    browser.track.mock.calls.filter(
      ([name]) => name === "search_results_viewed"
    )
  ).toHaveLength(2)
})

it("excludes hidden time and emits a single page exit", async () => {
  const journey = await import("../lib/analytics/journey")
  journey.commitPage()
  now = 2000
  visibility.hidden = true
  journey.visibilityChanged()
  now = 32000
  visibility.hidden = false
  journey.visibilityChanged()
  now = 35000
  journey.endPage()
  journey.endPage()
  expect(
    browser.track.mock.calls.filter(([name]) => name === "$pageview")
  ).toHaveLength(1)
  expect(
    browser.track.mock.calls.filter(([name]) => name === "$pageleave")
  ).toEqual([["$pageleave", { active_ms: 5000 }, true]])
})

it("counts query-driven views, ignores hash changes and refreshes, and assigns distinct view IDs", async () => {
  const journey = await import("../lib/analytics/journey")
  journey.commitPage()
  location.hash = "a-section"
  journey.commitPage()
  location.search = "?view=history"
  journey.commitPage()
  journey.commitPage()
  expect(
    browser.track.mock.calls.filter(([name]) => name === "$pageview")
  ).toHaveLength(2)
  const ids = browser.setViewContext.mock.calls.map(([id]) => id)
  expect(new Set(ids).size).toBe(2)
  expect(JSON.stringify(browser.track.mock.calls)).not.toContain("a-section")
})
