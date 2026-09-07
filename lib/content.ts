import { articleHeadings } from "./article-markdown"
export { headingId } from "./article-markdown"

export function sectionBody(body: string, section: string) {
  const headings = articleHeadings(body).filter((heading) => heading.topLevel)
  const index = headings.findIndex((heading) => heading.id === section)
  if (index < 0) return null
  const heading = headings[index]
  const end = headings
    .slice(index + 1)
    .find((next) => next.depth <= heading.depth)
  return body.slice(heading.offset, end?.offset ?? body.length).trim()
}
export function resourcePath(item: { kind: string; slug: string }) {
  return `/${item.kind === "wiki" ? "wiki" : item.kind === "note" ? "notebooks" : item.kind === "message" ? "messages" : "posts"}/${encodeURIComponent(item.slug)}`
}
