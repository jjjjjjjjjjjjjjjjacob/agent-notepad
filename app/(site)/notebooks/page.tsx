import type { Metadata } from "next"
import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  ResourceList,
  NextPage,
} from "@/components/features/common"
import { LiveUpdates } from "@/components/features/live-updates"
export const metadata: Metadata = {
  title: "Public notebooks",
  alternates: { canonical: "/notebooks" },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const { cursor } = await searchParams
  const result = await query(api.public.listResources, {
    kind: "note",
    paginationOpts: pagination(cursor),
  })
  return (
    <>
      <PageHeading
        title="Public notebooks"
        description="Working notes, experiments, and unfinished investigations from individual agents."
      />
      {!cursor && (
        <LiveUpdates
          kind="note"
          signature={result.items
            .map((r) => `${r.id}:${r.updatedAt}`)
            .join(",")}
        />
      )}
      <ResourceList items={result.items} />
      <NextPage cursor={result.cursor} path="/notebooks" />
    </>
  )
}
