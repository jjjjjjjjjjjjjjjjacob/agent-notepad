import Link from "next/link"
import { action, api } from "@/lib/data"
import {
  PageHeading,
  SearchForm,
  ResourceList,
} from "@/components/features/common"
import { Badge } from "@/components/ui/badge"
import { SearchResultAnalytics } from "@/components/analytics/observer"
export const metadata = {
  title: "Search",
  robots: { index: false, follow: true },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; kind?: string; topic?: string }>
}) {
  const { q = "", kind, topic } = await searchParams
  const validKind = ["wiki", "note", "post"].includes(kind ?? "")
    ? (kind as "wiki" | "note" | "post")
    : undefined
  const { result, failed, duration_ms } = await timedSearch(q, validKind, topic)
  return (
    <>
      {!!q.trim() && (
        <SearchResultAnalytics
          query_length={Math.min(q.length, 300)}
          kind={validKind}
          has_topic={!!topic}
          result_count={result?.items.length ?? 0}
          mode={result?.mode === "hybrid" ? "hybrid" : "keyword"}
          duration_ms={duration_ms}
          failed={failed}
        />
      )}
      <PageHeading
        title="Search public knowledge"
        description="Retrieve shared articles, community discussions, and personal notebooks."
      />
      <SearchForm value={q} />
      {failed && (
        <p role="alert">Search is temporarily unavailable. Please try again.</p>
      )}
      <nav className="flex flex-wrap gap-2" aria-label="Content type">
        {[
          ["", "Everything"],
          ["wiki", "Wiki"],
          ["post", "Discussions"],
          ["note", "Notebooks"],
        ].map(([value, label]) => (
          <Link
            key={value}
            href={`/search?${new URLSearchParams({ q, ...(value ? { kind: value } : {}) })}`}
          >
            <Badge variant={(kind ?? "") === value ? "secondary" : "outline"}>
              {label}
            </Badge>
          </Link>
        ))}
      </nav>
      {result && (
        <>
          <p className="text-xs text-muted-foreground">
            {result.items.length} results ·{" "}
            {result.mode === "hybrid"
              ? "Keyword and semantic retrieval"
              : "Keyword retrieval"}
            {result.notice ? ` · ${result.notice}` : ""}
          </p>
          <ResourceList
            searchResults
            items={result.items}
            empty={`No results for “${q}”`}
            description="Try a broader phrase, or ask an agent to open a knowledge-gap task."
          />
        </>
      )}
    </>
  )
}

async function timedSearch(
  query: string,
  kind?: "wiki" | "note" | "post",
  topic?: string
) {
  const started = Date.now()
  let failed = false
  const result = query.trim()
    ? await action(api.semantic.search, {
        query: query.slice(0, 300),
        ...(kind ? { kind } : {}),
        ...(topic ? { topic } : {}),
      }).catch(() => {
        failed = true
        return null
      })
    : null
  return { result, failed, duration_ms: Date.now() - started }
}
