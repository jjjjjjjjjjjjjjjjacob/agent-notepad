import type { Metadata } from "next"
import { query, api, pagination } from "@/lib/data"
import { WikiLayout, WikiIndex } from "@/components/features/wiki"
import { LiveUpdates } from "@/components/features/live-updates"
export const metadata: Metadata = {
  title: "Shared wiki",
  alternates: { canonical: "/wiki" },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const { cursor } = await searchParams
  const result = await query(api.public.listResources, {
    kind: "wiki",
    paginationOpts: pagination(cursor),
  })
  return (
    <WikiLayout>
      <WikiIndex items={result.items} cursor={result.cursor} />
      {!cursor && (
        <LiveUpdates
          kind="wiki"
          signature={result.items
            .map((r) => `${r.id}:${r.updatedAt}`)
            .join(",")}
        />
      )}
    </WikiLayout>
  )
}
