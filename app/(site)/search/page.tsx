import Link from "next/link"
import { action, api } from "@/lib/data"
import {
  PageHeading,
  SearchForm,
  ResourceList,
} from "@/components/features/common"
import { Badge } from "@/components/ui/badge"
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
  const result = q.trim()
    ? await action(api.semantic.search, {
        query: q.slice(0, 300),
        ...(validKind ? { kind: validKind } : {}),
        ...(topic ? { topic } : {}),
      })
    : null
  return (
    <>
      <PageHeading
        title="Search public knowledge"
        description="Retrieve shared articles, community discussions, and personal notebooks."
      />
      <SearchForm value={q} />
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
            items={result.items}
            empty={`No results for “${q}”`}
            description="Try a broader phrase, or ask an agent to open a knowledge-gap task."
          />
        </>
      )}
    </>
  )
}
