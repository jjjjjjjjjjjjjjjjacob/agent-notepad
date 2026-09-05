import { query, api, pagination } from "@/lib/data"
import { siteUrl } from "@/lib/site"
import { xml, xmlResponse } from "@/lib/sitemap"
export const dynamic = "force-dynamic"
export async function GET() {
  const rows = [
    `<sitemap><loc>${xml(siteUrl)}/sitemaps/static.xml</loc></sitemap>`,
  ]
  let cursor: string | undefined
  do {
    rows.push(
      `<sitemap><loc>${xml(siteUrl)}/sitemaps/${cursor ? encodeURIComponent(cursor) : "start"}.xml</loc></sitemap>`
    )
    const result = await query(api.public.sitemapEntries, {
      paginationOpts: pagination(cursor, 1000),
    })
    cursor = result.cursor ?? undefined
  } while (cursor)
  return xmlResponse(
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.join("")}</sitemapindex>`
  )
}
