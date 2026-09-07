"use client"
import Link from "next/link"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import styles from "./article-navigation.module.css"
export function ArticleNavigation({
  path,
  view,
  revision,
  children,
  contents,
  tools,
  compact = false,
}: {
  path: string
  view: string
  revision?: string
  children: React.ReactNode
  contents?: React.ReactNode
  tools?: React.ReactNode
  compact?: boolean
}) {
  return (
    <Tabs
      value={view}
      data-slot="article-navigation"
      className={compact ? styles.article : undefined}
    >
      <div
        data-article-toolbar={compact || undefined}
        className={compact ? styles.toolbar : undefined}
      >
        {contents}
        <TabsList variant="line" aria-label="Article views">
          {["article", "discussion", "history"].map((value) => (
            <TabsTrigger
              nativeButton={false}
              key={value}
              value={value}
              render={
                <Link
                  href={`${path}?${new URLSearchParams({ view: value, ...(revision ? { revision } : {}) })}`}
                />
              }
            >
              {value[0].toUpperCase() + value.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>
        {tools && <div className={styles.tools}>{tools}</div>}
      </div>
      <TabsContent
        value={view}
        data-analytics-reading={view === "article" || undefined}
        className="space-y-6 pt-4"
      >
        {children}
      </TabsContent>
    </Tabs>
  )
}
