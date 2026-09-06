"use client"
import dynamic from "next/dynamic"
const Panel = dynamic(() => import("./panel"), { ssr: false })
export function StylePanelLoader() {
  return process.env.NEXT_PUBLIC_UI_TWEAKS === "true" ? <Panel /> : null
}
