import { describe, it, expect } from "vitest"
import { defaultStyle } from "../lib/style-config"
import {
  heroSettings,
  heroParticleCount,
  HERO_MAX_PARTICLES,
} from "../lib/hero-settings"

describe("hero rendering budget and theme", () => {
  it("caps mobile particles and disables mouse response on touch layouts", () => {
    expect(
      heroSettings({ ...defaultStyle, heroDensity: 2 }, false, true)
    ).toMatchObject({ count: 3000, response: 0, scatter: 0, mobile: true })
    expect(
      heroSettings({ ...defaultStyle, heroDensity: 2 }, false, false).count
    ).toBe(12000)
  })
  it("scales density across the full desktop range with a smaller mobile budget", () => {
    expect(heroParticleCount(1, false)).toBe(6000)
    expect(heroParticleCount(1, true)).toBe(1500)
    expect(heroParticleCount(0.5, false)).toBe(3000)
    expect(heroParticleCount(3, false)).toBe(HERO_MAX_PARTICLES)
    expect(heroParticleCount(3, true)).toBe(3000)
  })
  it("keeps appearance, current shape, and interaction settings independent", () => {
    expect(
      heroSettings(
        {
          ...defaultStyle,
          heroSizeVariation: 0,
          heroOpacityVariation: 1,
          heroSoftness: 0.2,
          heroCenterFade: 0.4,
          heroCurrentSize: 720,
          heroTurbulence: 0,
          heroEvolution: 2,
          heroPointerRadius: 400,
          heroPointerSwirl: 0,
          heroHighlight: 0,
          heroScatterRadius: 80,
          heroSettling: 3,
        },
        false,
        false
      )
    ).toMatchObject({
      sizeVariation: 0,
      opacityVariation: 1,
      softness: 0.2,
      centerFade: 0.4,
      currentSize: 720,
      turbulence: 0,
      evolution: 2,
      pointerRadius: 400,
      pointerSwirl: 0,
      highlight: 0,
      scatterRadius: 80,
      settling: 3,
    })
  })
  it("uses the selected theme's link color, including custom presets", () => {
    const style = { ...defaultStyle, lightLink: "#ff0000", darkLink: "#00ff00" }
    expect(heroSettings(style, false, false).color).toEqual([1, 0, 0, 1])
    expect(heroSettings(style, true, false).color).toEqual([0, 1, 0, 1])
    expect(heroSettings(style, true, false)).toMatchObject({
      scatter: 0.8,
    })
  })
  it("preserves zero speed and independent variant selection", () => {
    expect(
      heroSettings(
        { ...defaultStyle, heroVariant: "notebook", heroSpeed: 0 },
        false,
        false
      )
    ).toMatchObject({ mode: 3, speed: 0, count: 6000 })
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
