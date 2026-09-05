"use client"
import { useSyncExternalStore } from "react"
const QUERY = "(max-width: 767px)"
function subscribe(callback: () => void) {
  const media = window.matchMedia(QUERY)
  media.addEventListener("change", callback)
  return () => media.removeEventListener("change", callback)
}
export function useIsMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  )
}
