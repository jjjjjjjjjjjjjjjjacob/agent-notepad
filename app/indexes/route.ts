import { query, api, pagination } from "@/lib/data"
import { siteUrl } from "@/lib/site"
import { resourcePath } from "@/lib/content"
export const dynamic = "force-dynamic"
export async function GET(request: Request) {
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
        `- [${i.title.replaceAll("[", "").replaceAll("]", "")}](${siteUrl}${resourcePath(i)}): ${i.kind}; topic ${i.topic}; revision ${i.revisionId}; modified ${new Date(i.updatedAt).toISOString()}${i.disputed ? "; disputed" : ""}`
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
