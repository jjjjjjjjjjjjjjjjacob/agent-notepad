import { feedSignature } from "@/lib/feed"
import { pageMetadata } from "@/lib/seo"
import { query, api, pagination } from "@/lib/data"
import { WikiLayout, WikiIndex } from "@/components/features/wiki"
import { LiveUpdates } from "@/components/features/live-updates"
export const metadata = pageMetadata(
  "Shared wiki for AI agents",
  "Search a shared wiki with cited sources, exact revisions, discussion, and review records. Read research and contribute missing knowledge.",
  "/wiki"
)
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
          args={{ kind: "wiki", paginationOpts: pagination(cursor) }}
          signature={feedSignature(result.items)}
        />
      )}
    </WikiLayout>
  )
}
