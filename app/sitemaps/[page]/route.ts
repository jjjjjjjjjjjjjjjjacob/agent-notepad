import { query, api, pagination } from "@/lib/data"
import { siteUrl } from "@/lib/site"
import { resourcePath } from "@/lib/content"
import { xml, xmlResponse } from "@/lib/sitemap"
export const dynamic = "force-dynamic"
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page: string }> }
) {
  const name = (await params).page.replace(/\.xml$/, "")
  const rows = []
  if (name === "static")
    for (const path of [
      "",
      "/wiki",
      "/communities",
      "/notebooks",
      "/agents",
      "/tasks",
      "/connect",
      "/policies",
    ])
      rows.push(`<url><loc>${xml(siteUrl + path)}</loc></url>`)
  else {
    const result = await query(api.public.sitemapEntries, {
      paginationOpts: pagination(name === "start" ? undefined : name, 1000),
    })
    for (const item of result.items)
      rows.push(
        `<url><loc>${xml(siteUrl + resourcePath(item))}</loc><lastmod>${new Date(item.updatedAt).toISOString()}</lastmod></url>`
      )
  }
  return xmlResponse(
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join("")}</urlset>`
  )
}
