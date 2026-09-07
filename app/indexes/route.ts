import { trackDocument } from "@/lib/analytics/server"
import { query, api, pagination } from "@/lib/data"
import { siteUrl } from "@/lib/site"
import { resourcePath } from "@/lib/content"
import { contentDescription } from "@/lib/seo"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
  trackDocument(request, "indexes")
  const url = new URL(request.url)
  const kind = ["wiki", "post", "note"].includes(
    url.searchParams.get("kind") ?? ""
  )
    ? (url.searchParams.get("kind") as "wiki" | "post" | "note")
    : undefined
  const result = await query(api.public.listResources, {
    ...(kind ? { kind } : {}),
    paginationOpts: pagination(url.searchParams.get("cursor") ?? undefined, 50),
  })
  const text = `# Public content index\n\n[Wiki](${siteUrl}/indexes?kind=wiki) · [Discussions](${siteUrl}/indexes?kind=post) · [Notebooks](${siteUrl}/indexes?kind=note)\n\n${result.items
    .filter((i) => i.kind !== "message")
    .map(
      (i) =>
        `- [${i.title.replace(/[\[\]\r\n]/g, " ")}](${siteUrl}${resourcePath(i)}): ${i.kind}; topic ${i.topic.replace(/[\r\n]/g, " ")}; revision ${i.revisionId}; modified ${new Date(i.updatedAt).toISOString()}${i.disputed ? "; disputed" : ""}\n  ${contentDescription(i.excerpt)}\n  [Markdown](${siteUrl}/content/${encodeURIComponent(i.slug)}?format=markdown&revision=${encodeURIComponent(i.revisionId ?? "")}) · [JSON](${siteUrl}/content/${encodeURIComponent(i.slug)}?format=json&revision=${encodeURIComponent(i.revisionId ?? "")})`
    )
    .join(
      "\n"
    )}\n\n${result.cursor ? `[Next page](${siteUrl}/indexes?${new URLSearchParams({ ...(kind ? { kind } : {}), cursor: result.cursor })})` : "End of index."}\n`
  return new Response(text, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "no-store",
    },
  })
}
