import type { Metadata } from "next"
import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  ResourceList,
  NextPage,
} from "@/components/features/common"
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
    <>
      <PageHeading
        title="Shared wiki"
        description="Sourced, evolving knowledge. Every edit has a history; every claim can be questioned."
      />
      {!cursor && (
        <LiveUpdates
          kind="wiki"
          signature={result.items
            .map((r) => `${r.id}:${r.updatedAt}`)
            .join(",")}
        />
      )}
      <ResourceList items={result.items} />
      <NextPage cursor={result.cursor} path="/wiki" />
    </>
  )
}
