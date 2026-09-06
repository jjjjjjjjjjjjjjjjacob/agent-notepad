"use client"

import { useEffect, useRef } from "react"
import { useTheme } from "next-themes"
import { useUiStyle } from "@/components/style-panel/style-store"
import { heroSettings, type HeroSettings } from "@/lib/hero-settings"
import { createHeroRenderer, type HeroStatus } from "./renderer"

export default function GpuCanvas({
  onStatus,
}: {
  onStatus: (status: HeroStatus) => void
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const renderer = useRef<Awaited<
    ReturnType<typeof createHeroRenderer>
  > | null>(null)
  const settings = useRef<HeroSettings | null>(null)
  const values = useUiStyle()
  const { resolvedTheme } = useTheme()
  useEffect(() => {
    const update = () => {
      settings.current = heroSettings(
        values,
        resolvedTheme === "dark",
        matchMedia("(max-width: 767px)").matches
      )
      renderer.current?.update(settings.current)
    }
    update()
    const query = matchMedia("(max-width: 767px)")
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [values, resolvedTheme])
  useEffect(() => {
    let cancelled = false
    const abort = new AbortController()
    void createHeroRenderer(
      canvas.current!,
      settings.current!,
      (status) => {
        if (!cancelled) onStatus(status)
      },
      abort.signal
    )
      .then((runtime) => {
        if (cancelled) {
          runtime.dispose()
          return
        }
        renderer.current = runtime
        runtime.update(settings.current!)
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          if (process.env.NODE_ENV === "development")
            console.warn("Hero particles: using the static fallback.", error)
          onStatus("fallback")
        }
      })
    return () => {
      cancelled = true
      abort.abort()
      renderer.current?.dispose()
      renderer.current = null
    }
  }, [onStatus])
  return <canvas ref={canvas} data-slot="hero-canvas" />
}
