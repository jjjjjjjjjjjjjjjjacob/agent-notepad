import type { StyleConfig } from "./style-config"

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
  opacity: number
  size: number
  response: number
  prism: number
  dark: boolean
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
    count: Math.min(
      mobile ? 1000 : 4000,
      Math.round(3000 * Number(style.heroDensity))
    ),
    speed: Number(style.heroSpeed),
    wind: Number(style.heroWind),
    convection: Number(style.heroConvection),
    viscosity: Number(style.heroViscosity),
    opacity: Number(style.heroOpacity),
    size: Number(style.heroSize),
    response: mobile ? 0 : Number(style.heroPointer),
    prism: mobile ? 0 : Number(style.heroPrism),
    dark,
    color: [
      parseInt(hex.slice(1, 3), 16) / 255,
      parseInt(hex.slice(3, 5), 16) / 255,
      parseInt(hex.slice(5, 7), 16) / 255,
      1,
    ],
    mobile,
  }
}
