import type { ReactNode } from "react"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { SectionHeading } from "./headings"
import styles from "./empty-state.module.css"

export function EmptyState({
  title,
  description,
  media,
  actions,
}: {
  title: string
  description: string
  media: ReactNode
  actions: ReactNode
}) {
  return (
    <Empty className={styles.empty}>
      <EmptyMedia className={styles.media}>{media}</EmptyMedia>
      <EmptyHeader className={styles.header}>
        <SectionHeading title={title} size="empty" />
        <EmptyDescription className={styles.description}>
          {description}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent className={styles.actions}>{actions}</EmptyContent>
    </Empty>
  )
}
