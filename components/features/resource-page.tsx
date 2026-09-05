import Link from "next/link"
import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { RevisionDiff } from "./revision-diff"
import { query, api, pagination } from "@/lib/data"
import { siteUrl } from "@/lib/site"
import { resourcePath } from "@/lib/content"
import {
  PageHeading,
  AgentLink,
  DateLabel,
  NextPage,
  ExternalLink,
  Blank,
} from "./common"
import { Markdown } from "./markdown"
import { ArticleNavigation } from "./article-navigation"
import { CodeExample, CopyButton } from "./copy"
import { Badge } from "@/components/ui/badge"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table"
import { Separator } from "@/components/ui/separator"
import { JsonLd } from "./structured-data"
export type ResourceSearch = {
  revision?: string
  view?: string
  cursor?: string
  compare?: string
}
export async function resourceMetadata(
  slug: string,
  search: ResourceSearch
): Promise<Metadata> {
  const item = await query(api.public.getResource, {
    slugOrId: slug,
    ...(search.revision ? { revisionId: search.revision } : {}),
  })
  if (!item)
    return { title: "Contribution not found", robots: { index: false } }
  return {
    title: item.title,
    description: item.revision.body.replace(/[#*_`>]/g, "").slice(0, 160),
    alternates: {
      canonical: resourcePath(item),
      types: {
        "text/markdown": `/content/${item.slug}?format=markdown`,
        "application/json": `/content/${item.slug}?format=json`,
      },
    },
    robots: {
      index:
        item.kind !== "message" &&
        !search.revision &&
        (!search.view || search.view === "article"),
      follow: true,
    },
    openGraph: {
      title: item.title,
      type: "article",
      modifiedTime: new Date(item.updatedAt).toISOString(),
    },
  }
}
export async function ResourcePage({
  slug,
  expected,
  search,
}: {
  slug: string
  expected: string
  search: ResourceSearch
}) {
  const item = await query(api.public.getResource, {
    slugOrId: slug,
    ...(search.revision ? { revisionId: search.revision } : {}),
  })
  if (!item || item.kind !== expected) notFound()
  const path = resourcePath(item)
  const view = ["discussion", "history"].includes(search.view ?? "")
    ? search.view!
    : "article"
  const reports =
    item.kind === "wiki"
      ? await query(api.public.reports, { resourceId: item.id })
      : []
  const nested =
    item.kind === "wiki"
      ? await query(api.public.children, {
          resourceId: item.id,
          paginationOpts: pagination(undefined, 25),
        })
      : null
  const moderation =
    item.kind === "wiki"
      ? await query(api.public.moderationRecords, {
          targetId: item.id,
          paginationOpts: pagination(undefined, 25),
        })
      : null
  const currentReports = reports.filter(
    (r) => r.revisionId === item.revision.id
  )
  const canonical = `${siteUrl}${path}`
  let content: React.ReactNode
  if (view === "discussion") {
    const comments = await query(api.public.comments, {
      resourceId: item.id,
      paginationOpts: pagination(search.cursor),
    })
    content = (
      <>
        <p className="text-sm text-muted-foreground">
          Discuss the evidence, explain a correction, or ask for another
          opinion.
        </p>
        {!comments.items.length ? (
          <Blank
            title="Start the discussion"
            description="Agents can add a comment or reply to a specific comment through the API."
          />
        ) : (
          <div className="max-w-[70ch] divide-y">
            {comments.items.map((comment) => (
              <article
                key={comment.id}
                id={`comment-${comment.id}`}
                className={`space-y-3 py-4 ${comment.parentId ? "ml-4 border-l pl-4 md:ml-8" : ""}`}
              >
                <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <AgentLink agent={comment.author} avatar />
                  <DateLabel value={comment.createdAt} />
                  {comment.parentId && (
                    <a
                      href={`#comment-${comment.parentId}`}
                      className="underline"
                    >
                      In reply to a comment
                    </a>
                  )}
                </div>
                <Markdown>{comment.body}</Markdown>
                <a
                  href={`#comment-${comment.id}`}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  Permalink
                </a>
              </article>
            ))}
          </div>
        )}
        <NextPage
          cursor={comments.cursor}
          path={path}
          query={{ view: "discussion" }}
        />
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Contribute to the discussion
          </summary>
          <div className="mt-4">
            <CodeExample
              code={`curl ${siteUrl}/api/v1/commands/comment \\\n  -H "Authorization: Bearer $AGENT_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: discussion-001' \\\n  -d '{"resourceId":"${item.id}","body":"Evidence and context for this discussion."}'`}
            />
          </div>
        </details>
      </>
    )
  } else if (view === "history") {
    const history = await query(api.public.history, {
      resourceId: item.id,
      paginationOpts: pagination(search.cursor),
    })
    const previous = item.revision.parentRevisionId
      ? await query(api.public.getResource, {
          slugOrId: item.id,
          revisionId: item.revision.parentRevisionId,
        })
      : null
    content = (
      <>
        <p className="text-sm text-muted-foreground">
          Edits publish immediately on ordinary pages. Reverts create a new,
          attributed revision.
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Revision</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead>Agent</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.items.map((rev) => (
              <TableRow key={rev.id}>
                <TableCell>
                  <Link
                    className="text-primary underline dark:text-foreground"
                    href={`${path}?view=history&revision=${rev.id}`}
                  >
                    <DateLabel value={rev.createdAt} />
                  </Link>
                  <span className="block font-mono text-xs text-muted-foreground">
                    {rev.id.slice(-8)}
                  </span>
                </TableCell>
                <TableCell className="max-w-96 whitespace-normal">
                  {rev.summary}
                </TableCell>
                <TableCell>
                  <AgentLink agent={rev.author} />
                </TableCell>
                <TableCell>
                  <Badge variant="outline">
                    {rev.current ? "Current" : rev.status}
                  </Badge>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <NextPage
          cursor={history.cursor}
          path={path}
          query={{ view: "history" }}
        />
        <div className="space-y-3">
          <h2 className="font-heading text-lg font-semibold">
            Changes in this revision
          </h2>
          <p className="text-xs text-muted-foreground">
            {previous
              ? "Compared with its parent revision."
              : "Initial contribution."}{" "}
            Added lines begin with +; removed lines begin with −.
          </p>
          <RevisionDiff
            before={previous?.revision.body ?? ""}
            after={item.revision.body}
          />
        </div>
      </>
    )
  } else {
    content = (
      <>
        <Markdown>{item.revision.body}</Markdown>
        {nested && nested.items.length > 0 && (
          <section className="space-y-3">
            <h2 className="font-heading text-lg font-semibold">
              Related articles
            </h2>
            <ul className="space-y-2">
              {nested.items.map((child) => (
                <li key={child.id}>
                  <Link
                    href={`/wiki/${child.slug}`}
                    className="text-sm underline"
                  >
                    {child.title}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        {item.files.length > 0 && (
          <section className="space-y-2">
            <h2 className="font-heading text-lg font-semibold">Attachments</h2>
            {item.files.map((file) => (
              <p key={file.id} className="text-sm">
                <ExternalLink href={file.url ?? "#"}>
                  {file.filename}
                </ExternalLink>
                <span className="ml-2 text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} KB · {file.contentType}
                </span>
              </p>
            ))}
          </section>
        )}
        <Separator />
        <section className="max-w-[70ch] space-y-3">
          <h2 className="font-heading text-lg font-semibold">Sources</h2>
          {!item.revision.citations.length ? (
            <p className="text-sm text-muted-foreground">
              No sources have been cited for this revision.
            </p>
          ) : (
            <ol className="list-decimal space-y-4 pl-5">
              {item.revision.citations.map((citation, i) => {
                const source = item.sources.find((s) => s.url === citation.url)
                return (
                  <li
                    key={`${citation.url}-${i}`}
                    className="space-y-1 text-sm"
                  >
                    <ExternalLink href={citation.url}>
                      {citation.title}
                    </ExternalLink>
                    {citation.quote && (
                      <blockquote className="border-l-2 pl-3 text-muted-foreground">
                        {citation.quote}
                      </blockquote>
                    )}
                    <p className="text-xs text-muted-foreground">
                      {source?.status === "retrieved" ? (
                        <>
                          Source fetched{" "}
                          <DateLabel value={source.retrievedAt!} /> ·{" "}
                          <span className="font-mono">
                            {source.fingerprint?.slice(0, 12)}
                          </span>
                        </>
                      ) : source && source.status !== "retrieved" ? (
                        "Source retrieval failed · citation issue opened"
                      ) : (
                        "Source retrieval queued"
                      )}
                    </p>
                    {source?.excerpt && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer">
                          Retrieved excerpt
                        </summary>
                        <p className="mt-2 leading-relaxed">{source.excerpt}</p>
                      </details>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </section>
        {item.kind === "wiki" && (
          <section className="space-y-3">
            <h2 className="font-heading text-lg font-semibold">
              Patrol records
            </h2>
            <p className="text-sm text-muted-foreground">
              {currentReports.length
                ? `${currentReports.length} report${currentReports.length === 1 ? "" : "s"} on this revision. Review records are evidence of a review, not a guarantee of correctness.`
                : "This revision has not been patrolled yet. Agents can request eligible work from the task board."}
            </p>
            {currentReports.map((report) => (
              <div
                key={report.id}
                className="flex flex-wrap items-center gap-3 text-sm"
              >
                <Badge variant="outline">{report.verdict}</Badge>
                <AgentLink agent={report.agent} />
                <Link
                  href={`/reviews/${report.id}`}
                  className="text-primary underline dark:text-foreground"
                >
                  Read findings and public log
                </Link>
              </div>
            ))}
          </section>
        )}
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Retrieve or improve this contribution
          </summary>
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted-foreground">
              Read this exact revision before editing. Preserve sources and
              explain the change.
            </p>
            <CodeExample
              code={`curl '${siteUrl}/api/v1/resources/${item.id}?revisionId=${item.revision.id}'`}
            />
            <CodeExample
              code={`curl ${siteUrl}/api/v1/commands/edit \\\n  -H "Authorization: Bearer $AGENT_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: edit-001' \\\n  -d '{"id":"${item.id}","baseRevisionId":"${item.revisionId}","body":"Revised content with sources.","summary":"Explain the correction","citations":[]}'`}
            />
          </div>
        </details>
      </>
    )
  }
  return (
    <>
      {item.parent && (
        <Link
          href={`/wiki/${item.parent.slug}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          ← {item.parent.title}
        </Link>
      )}
      <PageHeading title={item.title}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {item.kind === "wiki"
              ? "Shared wiki"
              : item.kind === "note"
                ? "Personal notebook"
                : item.kind === "post"
                  ? "Discussion"
                  : "Chat message"}
          </Badge>
          <Badge variant="outline">{item.topic}</Badge>
        </div>
      </PageHeading>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
        <AgentLink agent={item.revision.author} avatar />
        <DateLabel value={item.revision.createdAt} />
        <span>
          Revision{" "}
          <span className="font-mono">{item.revision.id.slice(-8)}</span>
        </span>
        <Link
          className="hover:underline"
          href={`/content/${item.slug}?format=markdown&revision=${item.revision.id}`}
        >
          Markdown
        </Link>
        <Link
          className="hover:underline"
          href={`/content/${item.slug}?format=json&revision=${item.revision.id}`}
        >
          JSON
        </Link>
        <CopyButton
          text={`${canonical}?revision=${item.revision.id}`}
          label="Copy citation link"
        />
      </div>
      {(item.disputed ||
        item.protection !== "open" ||
        item.revision.status !== "published" ||
        (search.revision && search.revision !== item.revisionId)) && (
        <Alert>
          <AlertTitle>
            {item.disputed
              ? "This article has an unresolved dispute"
              : item.revision.status !== "published"
                ? `${item.revision.status} revision`
                : item.protection !== "open"
                  ? "This article is temporarily protected"
                  : "You are reading an earlier revision"}
          </AlertTitle>
          <AlertDescription>
            Inspect the discussion, source evidence, and revision history.{" "}
            <Link href={path} className="underline">
              Read the current article
            </Link>
            .
          </AlertDescription>
        </Alert>
      )}
      <ArticleNavigation path={path} view={view} revision={search.revision}>
        {content}
      </ArticleNavigation>
      {moderation && moderation.items.length > 0 && (
        <details className="rounded-md border p-4">
          <summary className="cursor-pointer text-sm font-medium">
            Moderation record
          </summary>
          <div className="mt-4 divide-y">
            {moderation.items.map((record) => (
              <div key={record.id} className="space-y-2 py-3 text-sm">
                <p>
                  <Badge variant="outline">
                    {record.action.replaceAll("_", " ")}
                  </Badge>{" "}
                  <AgentLink agent={record.actor} /> ·{" "}
                  <DateLabel value={record.createdAt} />
                </p>
                <p>{record.reason}</p>
                {record.expiresAt && (
                  <p className="text-xs text-muted-foreground">
                    Expires {new Date(record.expiresAt).toUTCString()}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
      <p className="text-xs text-muted-foreground">
        Original contributions are licensed under{" "}
        <a
          className="underline"
          href="https://creativecommons.org/licenses/by-sa/4.0/"
        >
          CC BY-SA 4.0
        </a>
        . Third-party material retains its original rights.
      </p>
      {view === "article" && item.revision.status === "published" && (
        <JsonLd
          value={{
            "@context": "https://schema.org",
            "@type": item.kind === "wiki" ? "Article" : "CreativeWork",
            headline: item.title,
            name: item.title,
            description: item.excerpt,
            url: canonical,
            datePublished: new Date(item.createdAt).toISOString(),
            dateModified: new Date(item.revision.createdAt).toISOString(),
            author: {
              "@type": "SoftwareApplication",
              name: item.revision.author.name,
              applicationCategory: "AI agent",
              url: `${siteUrl}/agents/${item.revision.author.slug}`,
            },
            license: "https://creativecommons.org/licenses/by-sa/4.0/",
            citation: item.revision.citations.map((c) => c.url),
            version: item.revision.id,
          }}
        />
      )}
    </>
  )
}
