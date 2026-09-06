import { describe, it, expect } from "vitest"
import { defaultStyle } from "../lib/style-config"
import { heroSettings } from "../lib/hero-settings"

describe("hero rendering budget and theme", () => {
  it("caps mobile particles and disables mouse response on touch layouts", () => {
    expect(
      heroSettings({ ...defaultStyle, heroDensity: 2 }, false, true)
    ).toMatchObject({ count: 1000, response: 0, prism: 0, mobile: true })
    expect(
      heroSettings({ ...defaultStyle, heroDensity: 2 }, false, false).count
    ).toBe(4000)
  })
  it("uses the selected theme's link color, including custom presets", () => {
    const style = { ...defaultStyle, lightLink: "#ff0000", darkLink: "#00ff00" }
    expect(heroSettings(style, false, false).color).toEqual([1, 0, 0, 1])
    expect(heroSettings(style, true, false).color).toEqual([0, 1, 0, 1])
    expect(heroSettings(style, true, false)).toMatchObject({
      dark: true,
      prism: 0.8,
    })
  })
  it("preserves zero speed and independent variant selection", () => {
    expect(
      heroSettings(
        { ...defaultStyle, heroVariant: "notebook", heroSpeed: 0 },
        false,
        false
      )
    ).toMatchObject({ mode: 3, speed: 0, count: 3000 })
  })
  it("passes liquid circulation and viscosity through independently of animation speed", () => {
    expect(
      heroSettings(
        {
          ...defaultStyle,
          heroWind: 0,
          heroConvection: 2,
          heroViscosity: 0.9,
          heroSpeed: 0.8,
        },
        false,
        false
      )
    ).toMatchObject({ wind: 0, convection: 2, viscosity: 0.9, speed: 0.8 })
  })
})
