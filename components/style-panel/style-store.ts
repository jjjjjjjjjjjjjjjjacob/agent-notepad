"use client"

import { useSyncExternalStore } from "react"
import {
  defaultStyle,
  parseStyle,
  styleTokens,
  type StyleConfig,
} from "@/lib/style-config"

const storageKey = "agent-notepad:style:v1"
let values = defaultStyle
const listeners = new Set<() => void>()
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useUiStyle() {
  return useSyncExternalStore(
    subscribe,
    () => values,
    () => defaultStyle
  )
}

export function setUiStyle(
  next: StyleConfig | ((previous: StyleConfig) => StyleConfig)
) {
  if (process.env.NEXT_PUBLIC_UI_TWEAKS !== "true") return
  values = typeof next === "function" ? next(values) : next
  for (const [key, value] of Object.entries(styleTokens(values)))
    document.documentElement.style.setProperty(key, String(value))
  try {
    localStorage.setItem(storageKey, JSON.stringify({ version: 1, values }))
  } catch {
    /* Live controls work when browser storage is unavailable. */
  }
  listeners.forEach((listener) => listener())
}

export function loadStyleOverrides() {
  if (process.env.NEXT_PUBLIC_UI_TWEAKS !== "true") return
  try {
    const saved = localStorage.getItem(storageKey)
    if (saved) setUiStyle(parseStyle(JSON.parse(saved)))
  } catch {
    /* Invalid old browser settings leave the committed defaults active. */
  }
}
