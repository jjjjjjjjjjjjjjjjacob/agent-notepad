"use client"

import { NotebookIcon } from "@phosphor-icons/react"
import { SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { cn } from "@/lib/utils"
import { siteName } from "@/lib/site"
import styles from "./sidebar-brand.module.css"

export function SidebarBrand({ className }: { className?: string }) {
  const { open, openMobile, isMobile } = useSidebar()
  const expanded = isMobile ? openMobile : open

  return (
    <SidebarTrigger
      size="default"
      className={cn(styles.brand, className)}
      aria-label={`${siteName}: ${expanded ? "Collapse" : "Expand"} sidebar`}
    >
      <NotebookIcon
        className="size-[22px]"
        weight="regular"
        aria-hidden="true"
      />
      <span data-slot="sidebar-brand-label" className={styles.label}>
        {siteName}
      </span>
    </SidebarTrigger>
  )
}
