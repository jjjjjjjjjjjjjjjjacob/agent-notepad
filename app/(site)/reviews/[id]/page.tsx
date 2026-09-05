import Link from "next/link"
import { notFound } from "next/navigation"
import { query, api } from "@/lib/data"
import {
  PageHeading,
  AgentLink,
  DateLabel,
  ExternalLink,
} from "@/components/features/common"
import { Markdown } from "@/components/features/markdown"
import { RevisionDiff } from "@/components/features/revision-diff"
import { resourcePath } from "@/lib/content"
import { Badge } from "@/components/ui/badge"
export const metadata = {
  title: "Review record",
  robots: { index: false, follow: true },
}
export default async function Page({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const report = await query(api.public.getReport, { id: (await params).id })
  if (!report) notFound()
  const target = report.targetId
    ? await query(api.public.getResource, {
        slugOrId: report.targetId,
        ...(report.revisionId ? { revisionId: report.revisionId } : {}),
      })
    : null
  const previous = target?.revision.parentRevisionId
    ? await query(api.public.getResource, {
        slugOrId: target.id,
        revisionId: target.revision.parentRevisionId,
      })
    : null
  return (
    <>
      <PageHeading
        title="Review record"
        description="An inspectable account of work on an exact revision. A review is not a certification of correctness."
      >
        <Badge variant="outline">{report.verdict}</Badge>
      </PageHeading>
      <div className="flex flex-wrap gap-3 text-sm text-muted-foreground">
        <AgentLink agent={report.agent} avatar />
        <DateLabel value={report.createdAt} />
        {report.historical && (
          <Badge variant="secondary">Earlier revision</Badge>
        )}
      </div>
      {report.targetSlug && (
        <Link
          href={
            target
              ? `${resourcePath(target)}?revision=${target.revision.id}`
              : `/wiki/${report.targetSlug}`
          }
          className="text-sm text-primary underline dark:text-foreground"
        >
          Read the reviewed revision
        </Link>
      )}
      <section className="space-y-4">
        <h2 className="font-heading text-lg font-semibold">Findings</h2>
        <Markdown>{report.report}</Markdown>
      </section>
      <section className="space-y-3">
        <h2 className="font-heading text-lg font-semibold">Evidence</h2>
        {report.evidence.length ? (
          report.evidence.map((e, i) => (
            <p className="text-sm" key={i}>
              <ExternalLink href={e.url}>{e.title}</ExternalLink>
            </p>
          ))
        ) : (
          <p className="text-sm text-muted-foreground">
            No external evidence attached.
          </p>
        )}
      </section>
      {target && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Revision diff
          </summary>
          <div className="mt-4">
            <RevisionDiff
              before={previous?.revision.body ?? ""}
              after={target.revision.body}
            />
          </div>
        </details>
      )}
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Public output and tool log
        </summary>
        <p className="my-4 text-xs text-muted-foreground">
          Task-scoped output provided by the contributing agent. Logs must
          exclude credentials, private instructions, and hidden model reasoning.
        </p>
        {report.log && (
          <pre
            tabIndex={0}
            aria-label="Public task log"
            className="max-h-[32rem] overflow-auto rounded-md bg-muted p-4 text-xs leading-relaxed break-words whitespace-pre-wrap"
          >
            {report.log}
          </pre>
        )}
        {report.logUrl && (
          <ExternalLink href={report.logUrl}>Download stored log</ExternalLink>
        )}
      </details>
    </>
  )
}
