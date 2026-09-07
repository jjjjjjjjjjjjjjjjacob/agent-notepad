import committedPreset from "../config/ui-style.json"
import type { CSSProperties } from "react"
type Field = {
  label: string
  group: string
  section?: string
  description?: string
  css: string
  default: string | number | boolean
  kind: "number" | "color" | "font" | "boolean" | "select"
  options?: Record<string, string>
  min?: number
  max?: number
  step?: number
  unit?: string
}
const number = (
  label: string,
  group: string,
  css: string,
  value: number,
  min: number,
  max: number,
  unit = "px",
  step = 1
): Field => ({
  label,
  group,
  css,
  default: value,
  kind: "number",
  min,
  max,
  unit,
  step,
})
const color = (
  label: string,
  group: string,
  css: string,
  value: string
): Field => ({ label, group, css, default: value, kind: "color" })
const font = (label: string, css: string, value: string): Field => ({
  label,
  group: "Typography",
  css,
  default: value,
  kind: "font",
})
export const fonts: Record<string, { label: string; value: string }> = {
  source: { label: "Source Sans 3", value: "var(--font-source-sans)" },
  manrope: { label: "Manrope", value: "var(--font-manrope)" },
  serif: { label: "Merriweather", value: "var(--font-merriweather)" },
  geist: { label: "Geist Mono", value: "var(--font-geist-mono)" },
  system: { label: "System sans", value: "system-ui, sans-serif" },
  systemSerif: { label: "System serif", value: "Georgia, serif" },
  systemMono: { label: "System mono", value: "ui-monospace, monospace" },
}
// Particle controls share the preset/validation machinery with the rest of
// Style Lab; sections keep the larger set of live controls easy to scan.
const heroNumber = (
  section: string,
  label: string,
  css: string,
  value: number,
  min: number,
  max: number,
  unit: string,
  step: number,
  description?: string
): Field => ({
  ...number(label, "Hero animation", css, value, min, max, unit, step),
  section,
  description,
})
export const styleFields = {
  heroVariant: {
    label: "Particle effect",
    group: "Hero animation",
    section: "Appearance",
    css: "--hero-variant",
    default: "constellation",
    kind: "select",
    options: {
      constellation: "Liquid currents",
      wave: "Wave field",
      orbit: "Orbital streams",
      notebook: "Notebook assembly",
      off: "Off",
    },
  } as Field,
  heroDensity: heroNumber(
    "Appearance",
    "Particle density",
    "--hero-density",
    1,
    0.5,
    3,
    "×",
    0.1
  ),
  heroReach: heroNumber(
    "Appearance",
    "Particle field height",
    "--hero-reach",
    880,
    400,
    2000,
    "px",
    40
  ),
  heroOpacity: heroNumber(
    "Appearance",
    "Particle opacity",
    "--hero-opacity",
    0.4,
    0,
    1,
    "",
    0.05
  ),
  heroSize: heroNumber(
    "Appearance",
    "Particle size",
    "--hero-size",
    1.5,
    0.5,
    5,
    "px",
    0.1
  ),
  heroSizeVariation: heroNumber(
    "Appearance",
    "Size variation",
    "--hero-size-variation",
    0.3,
    0,
    0.9,
    "",
    0.05,
    "Mix small and large dots. Zero makes them uniform."
  ),
  heroOpacityVariation: heroNumber(
    "Appearance",
    "Opacity variation",
    "--hero-opacity-variation",
    0.65,
    0,
    1,
    "",
    0.05
  ),
  heroSoftness: heroNumber(
    "Appearance",
    "Particle softness",
    "--hero-softness",
    0.7,
    0,
    1,
    "",
    0.05,
    "From crisp dots to soft edges."
  ),
  heroCenterFade: heroNumber(
    "Appearance",
    "Center clarity",
    "--hero-center-fade",
    0.9,
    0,
    1,
    "",
    0.05,
    "Higher values keep reading areas clear. Lower values fill the center."
  ),
  heroSpeed: heroNumber(
    "Liquid motion",
    "Animation speed",
    "--hero-speed",
    0.6,
    0,
    2,
    "×",
    0.1,
    "Affects every effect. Zero pauses ambient motion; mouse interaction stays active."
  ),
  heroWind: heroNumber(
    "Liquid motion",
    "Drift",
    "--hero-wind",
    1,
    0,
    2,
    "×",
    0.1
  ),
  heroConvection: heroNumber(
    "Liquid motion",
    "Liquid circulation",
    "--hero-convection",
    1,
    0,
    2,
    "×",
    0.1
  ),
  heroViscosity: heroNumber(
    "Liquid motion",
    "Viscosity",
    "--hero-viscosity",
    0.7,
    0,
    1,
    "",
    0.05
  ),
  heroCurrentSize: heroNumber(
    "Liquid motion",
    "Current size",
    "--hero-current-size",
    360,
    120,
    720,
    "px",
    20,
    "Larger values create broad, rolling currents."
  ),
  heroTurbulence: heroNumber(
    "Liquid motion",
    "Fine eddies",
    "--hero-turbulence",
    1,
    0,
    2,
    "×",
    0.1,
    "Add small swirls within the larger currents."
  ),
  heroEvolution: heroNumber(
    "Liquid motion",
    "Current evolution",
    "--hero-evolution",
    1,
    0,
    2,
    "×",
    0.1,
    "How quickly the current pattern changes. Zero keeps its shape steady."
  ),
  heroPointer: heroNumber(
    "Mouse interaction",
    "Pointer response",
    "--hero-pointer",
    0.25,
    0,
    2,
    "",
    0.05
  ),
  heroPointerRadius: heroNumber(
    "Mouse interaction",
    "Pointer radius",
    "--hero-pointer-radius",
    170,
    60,
    400,
    "px",
    10
  ),
  heroPointerSwirl: heroNumber(
    "Mouse interaction",
    "Pointer swirl",
    "--hero-pointer-swirl",
    1,
    0,
    2,
    "×",
    0.1,
    "How strongly particles curl around the cursor."
  ),
  heroHighlight: heroNumber(
    "Mouse interaction",
    "Particle highlight",
    "--hero-highlight",
    0.5,
    0,
    1,
    "",
    0.05,
    "Brighten and enlarge dots near the cursor."
  ),
  heroScatter: heroNumber(
    "Mouse interaction",
    "Click scatter",
    "--hero-scatter",
    0.8,
    0,
    3,
    "",
    0.05
  ),
  heroScatterRadius: heroNumber(
    "Mouse interaction",
    "Scatter radius",
    "--hero-scatter-radius",
    250,
    80,
    480,
    "px",
    10
  ),
  heroSettling: heroNumber(
    "Mouse interaction",
    "Interaction settling",
    "--hero-settling",
    1.6,
    0.4,
    3,
    "s",
    0.1,
    "How long particles coast after stirring or scattering."
  ),
  bodyFont: font("Body font", "--ui-font-body", "source"),
  headingFont: font("Heading font", "--ui-font-heading", "manrope"),
  readingFont: font("Article font", "--font-reading", "source"),
  codeFont: font("Code font", "--ui-font-code", "geist"),
  bodySize: number("Body size", "Typography", "--body-size", 15, 13, 20),
  readingSize: number(
    "Article size",
    "Typography",
    "--reading-size",
    17,
    14,
    24
  ),
  headingScale: number(
    "Heading scale",
    "Typography",
    "--heading-scale",
    1,
    0.8,
    1.5,
    "",
    0.05
  ),
  headingWeight: number(
    "Heading weight",
    "Typography",
    "--heading-weight",
    650,
    400,
    800,
    "",
    50
  ),
  bodyWeight: number(
    "Body weight",
    "Typography",
    "--body-weight",
    400,
    300,
    600,
    "",
    50
  ),
  bodyLeading: number(
    "Body line height",
    "Typography",
    "--body-leading",
    1.55,
    1.2,
    2,
    "",
    0.05
  ),
  readingLeading: number(
    "Article line height",
    "Typography",
    "--reading-leading",
    1.75,
    1.3,
    2.2,
    "",
    0.05
  ),
  tracking: number(
    "Heading tracking",
    "Typography",
    "--heading-tracking",
    -0.035,
    -0.08,
    0.08,
    "em",
    0.005
  ),
  bodyTracking: number(
    "Body tracking",
    "Typography",
    "--body-tracking",
    0,
    -0.03,
    0.06,
    "em",
    0.005
  ),
  lightCanvas: color("Canvas", "Light colors", "--light-canvas", "#ffffff"),
  lightSurface: color("Surface", "Light colors", "--light-surface", "#f7f7f8"),
  lightText: color("Text", "Light colors", "--light-text", "#202124"),
  lightMuted: color(
    "Secondary text",
    "Light colors",
    "--light-muted",
    "#63666e"
  ),
  lightLine: color("Borders", "Light colors", "--light-line", "#e1e2e5"),
  lightLink: color("Links", "Light colors", "--light-link", "#185fc7"),
  darkCanvas: color("Canvas", "Dark colors", "--dark-canvas", "#101113"),
  darkSurface: color("Surface", "Dark colors", "--dark-surface", "#191a1e"),
  darkText: color("Text", "Dark colors", "--dark-text", "#f2f3f5"),
  darkMuted: color("Secondary text", "Dark colors", "--dark-muted", "#a3a6ae"),
  darkLine: color("Borders", "Dark colors", "--dark-line", "#303238"),
  darkLink: color("Links", "Dark colors", "--dark-link", "#7dbbff"),
  accent: color("Primary action", "Accents", "--action-color", "#2563eb"),
  actionText: color("Action text", "Accents", "--action-text", "#ffffff"),
  focus: color("Focus ring", "Accents", "--focus-color", "#4285f4"),
  success: color("Success", "Accents", "--success-color", "#27b57c"),
  danger: color("Danger", "Accents", "--danger-color", "#e65059"),
  identitySaturation: number(
    "Identity saturation",
    "Identity palette",
    "--identity-saturation",
    78,
    35,
    95,
    "%"
  ),
  identityShift: number(
    "Identity hue shift",
    "Identity palette",
    "--identity-shift",
    0,
    0,
    360,
    ""
  ),
  identityBlue: number(
    "Blue hue",
    "Identity palette",
    "--identity-hue-0",
    205,
    0,
    360,
    ""
  ),
  identityGreen: number(
    "Green hue",
    "Identity palette",
    "--identity-hue-1",
    153,
    0,
    360,
    ""
  ),
  identityGold: number(
    "Gold hue",
    "Identity palette",
    "--identity-hue-2",
    42,
    0,
    360,
    ""
  ),
  identityPurple: number(
    "Purple hue",
    "Identity palette",
    "--identity-hue-3",
    273,
    0,
    360,
    ""
  ),
  identityOrange: number(
    "Orange hue",
    "Identity palette",
    "--identity-hue-4",
    8,
    0,
    360,
    ""
  ),
  identityPink: number(
    "Pink hue",
    "Identity palette",
    "--identity-hue-5",
    328,
    0,
    360,
    ""
  ),
  identityLime: number(
    "Lime hue",
    "Identity palette",
    "--identity-hue-6",
    92,
    0,
    360,
    ""
  ),
  identityTeal: number(
    "Teal hue",
    "Identity palette",
    "--identity-hue-7",
    181,
    0,
    360,
    ""
  ),
  navWidth: number("Sidebar width", "Layout", "--nav-width", 220, 200, 360),
  pageWidth: number("Page width", "Layout", "--page-width", 1240, 800, 1800),
  readingWidth: number(
    "Reading width",
    "Layout",
    "--reading-width",
    850,
    560,
    1200
  ),
  pagePadding: number("Page padding", "Layout", "--page-padding", 32, 16, 56),
  rowPadding: number("Row density", "Layout", "--row-padding", 22, 12, 36),
  cardGap: number("Card gaps", "Layout", "--card-gap", 0, 0, 24),
  communityHeader: number(
    "Community header height",
    "Layout",
    "--community-header-height",
    112,
    80,
    200
  ),
  messageSpacing: number(
    "Message spacing",
    "Layout",
    "--message-spacing",
    14,
    6,
    28
  ),
  radius: number("Corner radius", "Details", "--radius", 8, 0, 20),
  lineWidth: number(
    "Border width",
    "Details",
    "--line-width",
    1,
    0,
    2,
    "px",
    0.5
  ),
  avatarSize: number("Avatar size", "Details", "--avatar-size", 36, 28, 56),
  iconSize: number("Navigation icons", "Details", "--icon-size", 18, 14, 24),
  motion: number(
    "Motion duration",
    "Details",
    "--motion-duration",
    140,
    0,
    400,
    "ms",
    10
  ),
  shadow: number(
    "Shadow strength",
    "Details",
    "--shadow-strength",
    0.04,
    0,
    0.2,
    "",
    0.01
  ),
  supportingPanels: {
    label: "Supporting panels",
    group: "Details",
    css: "--support-display",
    default: true,
    kind: "boolean",
  } as Field,
} satisfies Record<string, Field>
export type StyleKey = keyof typeof styleFields
export type StyleConfig = Record<StyleKey, string | number | boolean>
const baseStyle = Object.fromEntries(
  Object.entries(styleFields).map(([k, v]) => [k, v.default])
) as StyleConfig
export function parseStyle(value: unknown): StyleConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Choose a valid styling preset.")
  const envelope = value as Record<string, unknown>
  if (
    envelope.version !== 1 ||
    !envelope.values ||
    typeof envelope.values !== "object" ||
    Array.isArray(envelope.values)
  )
    throw new Error("This preset must use version 1.")
  const values = envelope.values as Record<string, unknown>
  const result = { ...baseStyle }
  for (const [key, value] of Object.entries(values)) {
    // Retire the removed light effect without invalidating saved v1 presets.
    if (key === "heroPrism") {
      if (
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value < 0 ||
        value > 1
      )
        throw new Error("Invalid value for retired Prismatic light setting.")
      continue
    }
    if (!Object.hasOwn(styleFields, key))
      throw new Error(`Unknown setting: ${key}`)
    const field: Field = styleFields[key as StyleKey]
    const valid =
      field.kind === "number"
        ? typeof value === "number" &&
          Number.isFinite(value) &&
          value >= field.min! &&
          value <= field.max!
        : field.kind === "color"
          ? typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value)
          : field.kind === "font"
            ? typeof value === "string" && Object.hasOwn(fonts, value)
            : field.kind === "select"
              ? typeof value === "string" &&
                Object.hasOwn(field.options!, value)
              : typeof value === "boolean"
    if (!valid) throw new Error(`Invalid value for ${field.label}.`)
    result[key as StyleKey] = value as string | number | boolean
  }
  return result
}
export const defaultStyle = parseStyle(committedPreset)
export function styleTokens(config: StyleConfig): CSSProperties {
  const css: Record<string, string> = {}
  for (const [key, f] of Object.entries(styleFields)) {
    const field: Field = f,
      value = config[key as StyleKey]
    css[field.css] =
      field.kind === "font"
        ? fonts[String(value)].value
        : field.kind === "boolean"
          ? value
            ? "block"
            : "none"
          : `${value}${field.unit === "×" ? "" : (field.unit ?? "")}`
  }
  css["--support-width"] = config.supportingPanels ? "260px" : "0px"
  return css as CSSProperties
}
export const stylePresets: Record<string, StyleConfig> = {
  Notepad: defaultStyle,
  Compact: {
    ...defaultStyle,
    bodySize: 14,
    rowPadding: 14,
    navWidth: 220,
    messageSpacing: 8,
    pagePadding: 24,
  },
  "Reading room": {
    ...defaultStyle,
    readingFont: "serif",
    readingSize: 19,
    readingLeading: 1.85,
    readingWidth: 760,
    supportingPanels: false,
  },
  Vivid: {
    ...defaultStyle,
    identitySaturation: 92,
    accent: "#7045ef",
    darkLink: "#b99cff",
    lightLink: "#6232c4",
    radius: 10,
  },
}
