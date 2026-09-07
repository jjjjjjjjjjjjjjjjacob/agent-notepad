import type { StyleConfig } from "./style-config"

export const HERO_MAX_PARTICLES = 18000
export function heroParticleCount(density: number, mobile: boolean) {
  return Math.min(
    mobile ? 3000 : HERO_MAX_PARTICLES,
    Math.round((mobile ? 1500 : 6000) * density)
  )
}

export const heroModes = {
  constellation: 0,
  wave: 1,
  orbit: 2,
  notebook: 3,
} as const
export type HeroSettings = {
  mode: number
  count: number
  speed: number
  wind: number
  convection: number
  viscosity: number
  currentSize: number
  turbulence: number
  evolution: number
  sizeVariation: number
  opacityVariation: number
  softness: number
  centerFade: number
  pointerRadius: number
  pointerSwirl: number
  highlight: number
  scatterRadius: number
  settling: number
  opacity: number
  size: number
  response: number
  scatter: number
  color: [number, number, number, number]
  mobile: boolean
}

export function heroSettings(
  style: StyleConfig,
  dark: boolean,
  mobile: boolean
): HeroSettings {
  const hex = String(dark ? style.darkLink : style.lightLink)
  return {
    mode: heroModes[style.heroVariant as keyof typeof heroModes] ?? 0,
    count: heroParticleCount(Number(style.heroDensity), mobile),
    speed: Number(style.heroSpeed),
    wind: Number(style.heroWind),
    convection: Number(style.heroConvection),
    viscosity: Number(style.heroViscosity),
    currentSize: Number(style.heroCurrentSize),
    turbulence: Number(style.heroTurbulence),
    evolution: Number(style.heroEvolution),
    sizeVariation: Number(style.heroSizeVariation),
    opacityVariation: Number(style.heroOpacityVariation),
    softness: Number(style.heroSoftness),
    centerFade: Number(style.heroCenterFade),
    pointerRadius: Number(style.heroPointerRadius),
    pointerSwirl: Number(style.heroPointerSwirl),
    highlight: Number(style.heroHighlight),
    scatterRadius: Number(style.heroScatterRadius),
    settling: Number(style.heroSettling),
    opacity: Number(style.heroOpacity),
    size: Number(style.heroSize),
    response: mobile ? 0 : Number(style.heroPointer),
    scatter: mobile ? 0 : Number(style.heroScatter),
    color: [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
      1,
    ],
    mobile,
  }
}
