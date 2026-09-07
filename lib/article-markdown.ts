import { fromMarkdown } from "mdast-util-from-markdown"
import { gfmFromMarkdown } from "mdast-util-gfm"
import { gfm } from "micromark-extension-gfm"
import type { RootContent } from "mdast"

export function parseArticleMarkdown(body: string) {
  return fromMarkdown(body, {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  })
}

export function headingId(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}

export function articleNodeText(node: RootContent): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value
  if (node.type === "image" || node.type === "imageReference")
    return node.alt ?? ""
  return "children" in node ? node.children.map(articleNodeText).join("") : ""
}

export type ArticleHeading = {
  id: string
  title: string
  depth: number
  offset: number
  topLevel: boolean
}

/** Shared by rendering, contents, and section retrieval, including repeated headings. */
export function articleHeadings(body: string): ArticleHeading[] {
  const used = new Set(["article-title", "article-sources", "article-reviews"])
  const headings: ArticleHeading[] = []
  function walk(nodes: RootContent[], topLevel: boolean) {
    for (const node of nodes) {
      if (node.type === "heading") {
        const title = articleNodeText(node)
        const base = headingId(title) || "section"
        let id = base
        let suffix = 1
        while (used.has(id) || /^(source-\d+|cite-\d+-\d+)$/.test(id)) {
          id = `${base}-${++suffix}`
        }
        used.add(id)
        headings.push({
          id,
          title,
          depth: node.depth,
          offset: node.position!.start.offset!,
          topLevel,
        })
      }
      if ("children" in node) walk(node.children as RootContent[], false)
    }
  }
  walk(parseArticleMarkdown(body).children, true)
  return headings
}

export type ContentsEntry = {
  id: string
  title: string
  children: ContentsEntry[]
}

export function articleContents(body: string): ContentsEntry[] {
  const entries: ContentsEntry[] = []
  const ancestors: { depth: number; entry: ContentsEntry }[] = []
  for (const heading of articleHeadings(body).filter(
    (heading) => heading.topLevel
  )) {
    const depth = Math.max(2, heading.depth)
    while (ancestors.length && ancestors.at(-1)!.depth >= depth) ancestors.pop()
    const entry: ContentsEntry = {
      id: heading.id,
      title: heading.title || "Untitled section",
      children: [],
    }
    const parent = ancestors.at(-1)
    ;(parent ? parent.entry.children : entries).push(entry)
    ancestors.push({ depth, entry })
  }
  return entries
}
