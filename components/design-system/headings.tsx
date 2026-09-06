import type { ReactNode } from "react"
import { cn } from "@/lib/utils"
import { ActionLink } from "./controls"
import styles from "./headings.module.css"

export type PageHeadingProps = {
  eyebrow?: ReactNode
  title: ReactNode
  description?: ReactNode
  status?: ReactNode
  leading?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  id?: string
  className?: string
  variant?: "page" | "article" | "community" | "channel"
}

/** The single title/eyebrow contract for destination and detail pages. */
export function PageHeading({
  eyebrow,
  title,
  description,
  status,
  leading,
  actions,
  children,
  id,
  className,
  variant = "page",
}: PageHeadingProps) {
  return (
    <header
      data-slot="page-heading"
      data-variant={variant}
      className={cn(styles.page, className)}
    >
      {leading && <div className={styles.leading}>{leading}</div>}
      <div className={styles.copy}>
        {eyebrow && (
          <div data-slot="page-eyebrow" className={styles.eyebrow}>
            {eyebrow}
          </div>
        )}
        <div className={styles.titleRow}>
          <h1 id={id} className={styles.title}>
            {title}
          </h1>
          {status && <div className={styles.status}>{status}</div>}
        </div>
        {description && (
          <p data-slot="page-description" className={styles.description}>
            {description}
          </p>
        )}
      </div>
      {(actions || children) && (
        <div data-slot="page-actions" className={styles.actions}>
          {actions}
          {children}
        </div>
      )}
    </header>
  )
}

export function SectionHeading({
  title,
  id,
  href,
  label = "View all",
  actions,
  className,
  size = "section",
}: {
  title: ReactNode
  id?: string
  href?: string
  label?: string
  actions?: ReactNode
  className?: string
  size?: "section" | "subsection" | "panel"
}) {
  return (
    <div
      data-slot="section-heading"
      data-size={size}
      className={cn(styles.section, className)}
    >
      <h2 id={id}>{title}</h2>
      {(href || actions) && (
        <div className={styles.sectionActions}>
          {actions}
          {href && (
            <ActionLink href={href} variant="ghost" arrow="right">
              {label}
            </ActionLink>
          )}
        </div>
      )}
    </div>
  )
}
