import { afterEach, describe, expect, it, vi } from "vitest"
import { isOperationEnabled, isPlaceEnabled } from "../lib/features"
import { openapi } from "../lib/openapi"
import { forwardApi } from "../lib/gateway"

vi.mock("server-only", () => ({}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe("Place discovery rollout", () => {
  it.each([
    "place_config",
    "place_pixel?pixel=5",
    "commands/place_create",
    "commands/%70lace_paint",
    "%63ommands/place_create",
    "me/place_wallet",
    "resources/example/place_config",
  ])(
    "blocks %s at the web gateway even if the backend exposes it",
    async (path) => {
      vi.stubEnv("PLACE_ENABLED", "false")
      vi.stubEnv("NEXT_PUBLIC_CONVEX_SITE_URL", "https://backend.example")
      const upstream = vi.fn(async () => Response.json({ data: {} }))
      vi.stubGlobal("fetch", upstream)
      expect((await forwardApi(path)).status).toBe(404)
      expect(upstream).not.toHaveBeenCalled()
      vi.stubEnv("PLACE_ENABLED", "true")
      expect((await forwardApi(path)).status).toBe(200)
      expect(upstream).toHaveBeenCalledOnce()
    }
  )

  it.each([undefined, "false", "TRUE", "1", "true"])(
    "requires an explicit true flag (%s)",
    (value) => {
      vi.stubEnv("PLACE_ENABLED", value)
      const enabled = value === "true"
      expect(isPlaceEnabled()).toBe(enabled)
      expect(isOperationEnabled("place_paint")).toBe(enabled)
      const paths = openapi().paths
      expect(Object.hasOwn(paths, "/place_config")).toBe(enabled)
      expect(Object.hasOwn(paths, "/commands/place_create")).toBe(enabled)
      expect(Object.hasOwn(paths, "/commands/place_paint")).toBe(enabled)
      expect(Object.hasOwn(paths, "/commands/integrity_flag")).toBe(true)
      expect(Object.hasOwn(paths, "/integrity_evidence")).toBe(true)
      expect(Object.hasOwn(paths, "/search")).toBe(true)
    }
  )

  it.each(["false", "true"])(
    "keeps the published agent guide consistent with rollout (%s)",
    async (value) => {
      vi.stubEnv("PLACE_ENABLED", value)
      vi.resetModules()
      const { agentGuide } = await import("../lib/agent-guide")
      expect(agentGuide.includes("/account/place")).toBe(value === "true")
      expect(agentGuide.includes("place_create")).toBe(value === "true")
      expect(agentGuide).toContain("get_integrity_evidence")
    }
  )
})
