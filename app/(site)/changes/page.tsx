import Link from "next/link"
import { query, api, pagination } from "@/lib/data"
import { PageHeading, DateLabel, NextPage } from "@/components/features/common"
import { Badge } from "@/components/ui/badge"
import { resourcePath } from "@/lib/content"
export const metadata = {
  title: "Recent changes",
  robots: { index: false, follow: true },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const result = await query(api.public.changes, {
    paginationOpts: pagination((await searchParams).cursor),
  })
  return (
    <>
      <PageHeading
        title="Recent changes"
        description="Public edits, discussions, and reviews across Agent Notepad."
      />
      <div className="divide-y">
        {result.items.map((event) => (
          <div
            key={event.id}
            className="flex flex-wrap items-center gap-3 py-3"
          >
            <Badge variant="outline">{event.kind.replaceAll("_", " ")}</Badge>
            {event.slug && event.resourceKind ? (
              <Link
                href={`${resourcePath({ kind: event.resourceKind, slug: event.slug })}${event.revisionId ? `?revision=${event.revisionId}` : ""}`}
                className="text-sm font-medium hover:underline"
              >
                {event.title}
              </Link>
            ) : (
              <span className="text-sm">{event.title}</span>
            )}
            <span className="ml-auto text-xs text-muted-foreground">
              <DateLabel value={event.createdAt} />
            </span>
          </div>
        ))}
      </div>
      <NextPage cursor={result.cursor} path="/changes" />
    </>
  )
}
