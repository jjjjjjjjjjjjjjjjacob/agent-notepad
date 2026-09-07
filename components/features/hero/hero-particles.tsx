"use client"

import dynamic from "next/dynamic"
import { useId, useState, useSyncExternalStore } from "react"
import { useUiStyle } from "@/components/style-panel/style-store"
import type { HeroStatus } from "./renderer"
import styles from "./hero.module.css"

const GpuCanvas = dynamic(() => import("./gpu-canvas"), { ssr: false })
const subscribeMotion = (callback: () => void) => {
  const query = matchMedia("(prefers-reduced-motion: reduce)")
  query.addEventListener("change", callback)
  return () => query.removeEventListener("change", callback)
}
const staticRequired = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches || !navigator.gpu
const serverStatic = () => true
const dots = Array.from({ length: 2160 }, (_, i) => {
  const x = ((i * 137.508) % 1000) / 1000
  const y = ((i * 71.33) % 1000) / 1000
  return {
    x,
    y,
    size: ((i * 0.618034) % 1) * 2 - 1,
    alpha: (i * 0.754877) % 1,
    opacity: Math.min(1, Math.max(0, (Math.abs(x - 0.5) - 0.12) * 4)),
  }
})

export function HeroParticles() {
  const values = useUiStyle()
  const softnessId = useId()
  const fallback = useSyncExternalStore(
    subscribeMotion,
    staticRequired,
    serverStatic
  )
  const [status, setStatus] = useState<HeroStatus>("initializing")
  if (values.heroVariant === "off") return null
  const state = fallback ? "fallback" : status
  return (
    <div
      className={styles.particles}
      aria-hidden="true"
      data-slot="hero-particles"
      data-variant={String(values.heroVariant)}
      data-render-state={state}
    >
      <svg className={styles.static}>
        <defs>
          <radialGradient id={softnessId}>
            <stop
              offset={`${(0.9 - Number(values.heroSoftness) * 0.85) * 100}%`}
              stopColor="var(--link-color)"
            />
            <stop offset="100%" stopColor="var(--link-color)" stopOpacity="0" />
          </radialGradient>
        </defs>
        {dots
          .slice(0, Math.round(720 * Number(values.heroDensity)))
          .map((dot, i) => (
            <circle
              key={i}
              cx={`${dot.x * 100}%`}
              cy={`${dot.y * 100}%`}
              r={
                Number(values.heroSize) *
                (1 + dot.size * Number(values.heroSizeVariation))
              }
              fill={`url(#${softnessId})`}
              opacity={
                (1 - Number(values.heroCenterFade) * (1 - dot.opacity)) *
                (1 - Number(values.heroOpacityVariation) * (1 - dot.alpha))
              }
            />
          ))}
      </svg>
      {!fallback && <GpuCanvas onStatus={setStatus} />}
    </div>
  )
}
