import { describe, it, expect } from "vitest"
import {
  defaultStyle,
  parseStyle,
  styleTokens,
  stylePresets,
} from "../lib/style-config"
import { validateEnvironment, allowedFrontendOrigin } from "../lib/environment"
describe("styling presets", () => {
  it("round trips every preset and resolves font roles to bundled font tokens", () => {
    for (const values of Object.values(stylePresets))
      expect(
        parseStyle(JSON.parse(JSON.stringify({ version: 1, values })))
      ).toEqual(values)
    expect(styleTokens(defaultStyle)).toMatchObject({
      "--ui-font-body": "var(--font-source-sans)",
      "--support-width": "260px",
    })
  })
  it("keeps version-1 presets compatible and validates hero variants and bounds", () => {
    expect(parseStyle({ version: 1, values: { bodySize: 16 } })).toMatchObject({
      bodySize: 16,
      heroVariant: "constellation",
      heroDensity: 1,
      heroWind: 1,
      heroConvection: 1,
      heroPrism: 0.8,
      heroViscosity: 0.7,
      heroReach: 880,
    })
    for (const heroVariant of [
      "constellation",
      "wave",
      "orbit",
      "notebook",
      "off",
    ])
      expect(
        parseStyle({ version: 1, values: { heroVariant } }).heroVariant
      ).toBe(heroVariant)
    for (const values of [
      { heroVariant: "unknown" },
      { heroVariant: "constructor" },
      { heroDensity: 20 },
      { heroOpacity: -1 },
      { heroSpeed: Infinity },
      { heroSize: "1px" },
      { heroWind: -1 },
      { heroConvection: 3 },
      { heroPrism: 2 },
      { heroViscosity: -1 },
      { heroReach: 2000 },
    ])
      expect(() => parseStyle({ version: 1, values })).toThrow()
  })
  it("rejects invalid imports rather than injecting arbitrary CSS", () => {
    for (const values of [
      { accent: "url(evil)" },
      { navWidth: -100 },
      { bodyFont: "unknown" },
      { unknown: 1 },
      { constructor: false },
      { bodySize: Infinity },
    ])
      expect(() => parseStyle({ version: 1, values })).toThrow()
    expect(() => parseStyle({ version: 2, values: defaultStyle })).toThrow()
  })
})
describe("backend separation", () => {
  const dev = {
    NEXT_PUBLIC_CONVEX_URL: "https://incredible-boar-27.convex.cloud",
    NEXT_PUBLIC_CONVEX_SITE_URL: "https://incredible-boar-27.convex.site",
    NEXT_PUBLIC_SITE_URL: "http://localhost:3843",
  }
  it("uses the same dev target locally and on preview, and rejects it in production", () => {
    expect(validateEnvironment(dev)).toBe("development")
    expect(validateEnvironment({ ...dev, VERCEL_ENV: "preview" })).toBe(
      "development"
    )
    expect(() =>
      validateEnvironment({
        ...dev,
        VERCEL_ENV: "production",
        APP_ENV: "development",
      })
    ).toThrow()
    expect(
      validateEnvironment({
        ...dev,
        VERCEL_ENV: "production",
        NEXT_PUBLIC_CONVEX_URL: "https://gregarious-chickadee-782.convex.cloud",
        NEXT_PUBLIC_CONVEX_SITE_URL: "https://api.agentnotepad.com",
        NEXT_PUBLIC_SITE_URL: "https://agentnotepad.com",
      })
    ).toBe("production")
  })
  it("requires explicit test isolation and validates MCP origins", () => {
    expect(() => validateEnvironment({ ...dev, APP_ENV: "test" })).toThrow()
    const isolated = {
      ...dev,
      APP_ENV: "test",
      TEST_BACKEND_ISOLATED: "true",
      NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3215",
      NEXT_PUBLIC_CONVEX_SITE_URL: "http://127.0.0.1:3216",
    }
    expect(validateEnvironment(isolated)).toBe("test")
    expect(() =>
      validateEnvironment({
        ...isolated,
        NEXT_PUBLIC_CONVEX_SITE_URL: "https://example.com:3216",
      })
    ).toThrow()
    expect(() =>
      validateEnvironment({ ...isolated, TEST_BACKEND_ISOLATED: "false" })
    ).toThrow()
    expect(allowedFrontendOrigin("https://foreign.vercel.app", dev)).toBe(false)
    expect(allowedFrontendOrigin("http://localhost:3843", dev)).toBe(true)
  })
})
