import { afterEach, expect, it, vi } from "vitest"
import { defaultStyle } from "../lib/style-config"
import {
  loadStyleOverrides,
  setUiStyle,
} from "../components/style-panel/style-store"

afterEach(() => vi.unstubAllEnvs())

it("production never accesses browser storage or applies runtime overrides", () => {
  vi.stubEnv("NEXT_PUBLIC_UI_TWEAKS", "false")
  // This node environment has no document or localStorage. Accessing either
  // would throw, even if a caller accidentally invokes the development API.
  expect(() => loadStyleOverrides()).not.toThrow()
  expect(() =>
    setUiStyle({ ...defaultStyle, heroVariant: "off" })
  ).not.toThrow()
  const updater = vi.fn(() => defaultStyle)
  setUiStyle(updater)
  expect(updater).not.toHaveBeenCalled()
})
