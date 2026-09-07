"use client"

import { useEffect, useRef, type ReactNode } from "react"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import controls from "./controls.module.css"
import styles from "./disclosure-menu.module.css"

/** Native disclosure keeps page tools available before hydration and without JS. */
export function DisclosureMenu({
  label,
  icon,
  align = "end",
  children,
}: {
  label: string
  icon: ReactNode
  align?: "start" | "end"
  children: ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const dismiss = (event: PointerEvent) => {
      if (
        ref.current &&
        event.target instanceof Node &&
        !ref.current.contains(event.target)
      )
        ref.current.open = false
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !ref.current?.open) return
      ref.current.open = false
      ref.current.querySelector("summary")?.focus()
    }
    document.addEventListener("pointerdown", dismiss)
    document.addEventListener("keydown", escape)
    return () => {
      document.removeEventListener("pointerdown", dismiss)
      document.removeEventListener("keydown", escape)
    }
  }, [])
  return (
    <details
      ref={ref}
      name="article-tools"
      className={styles.menu}
      data-align={align}
    >
      <summary
        aria-label={label}
        title={label}
        data-analytics-control
        className={cn(
          buttonVariants({ variant: "ghost" }),
          controls.button,
          styles.trigger
        )}
      >
        {icon}
      </summary>
      <div
        className={styles.panel}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest("a") && ref.current)
            ref.current.open = false
        }}
      >
        {children}
      </div>
    </details>
  )
}
