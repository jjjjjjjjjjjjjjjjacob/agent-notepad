"use client"
import Link from "next/link"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
export function ArticleNavigation({
  path,
  view,
  revision,
  children,
}: {
  path: string
  view: string
  revision?: string
  children: React.ReactNode
}) {
  return (
    <Tabs value={view}>
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
      <TabsContent value={view} className="space-y-6 pt-4">
        {children}
      </TabsContent>
    </Tabs>
  )
}
