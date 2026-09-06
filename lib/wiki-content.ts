import { fromMarkdown } from "mdast-util-from-markdown"
import type { RootContent } from "mdast"

export type WikiLink = { slug: string; title: string }

export function wikiSlug(href: string, origin?: string): string | null {
  try {
    if (
      !href.startsWith("/wiki/") &&
      !(origin && new URL(href).origin === new URL(origin).origin)
    )
      return null
    const path = new URL(href, "https://wiki.invalid").pathname
    const match = /^\/wiki\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/.exec(path)
    return match && match[1] !== "map" ? match[1] : null
  } catch {
    return null
  }
}

// Parse Markdown so examples in code, images, and external lookalike URLs never become edges.
export function wikiLinks(body: string, origin?: string): WikiLink[] {
  const tree = fromMarkdown(body)
  const definitions = new Map<string, string>()
  const links = new Map<string, WikiLink>()
  const walk = (nodes: RootContent[], visit: (node: RootContent) => void) => {
    for (const node of nodes) {
      visit(node)
      if ("children" in node) walk(node.children as RootContent[], visit)
    }
  }
  walk(tree.children, (node) => {
    if (node.type === "definition") definitions.set(node.identifier, node.url)
  })
  walk(tree.children, (node) => {
    const url =
      node.type === "link"
        ? node.url
        : node.type === "linkReference"
          ? definitions.get(node.identifier)
          : undefined
    const slug = url ? wikiSlug(url, origin) : null
    if (!slug || links.has(slug)) return
    let title = ""
    if ("children" in node)
      walk(node.children as RootContent[], (child) => {
        if (child.type === "text" || child.type === "inlineCode")
          title += child.value
      })
    links.set(slug, {
      slug,
      title: title.trim().slice(0, 200) || slug.replaceAll("-", " "),
    })
  })
  return [...links.values()].slice(0, 100)
}

export function articleStats(body: string, sourceCount: number) {
  return {
    wordCount: markdownText(body).split(/\s+/).filter(Boolean).length,
    sourceCount,
  }
}

export function markdownText(body: string): string {
  const text: string[] = []
  const walk = (nodes: RootContent[]) => {
    for (const node of nodes) {
      if (node.type === "text" || node.type === "inlineCode")
        text.push(node.value)
      if ("children" in node) walk(node.children as RootContent[])
    }
  }
  walk(fromMarkdown(body).children)
  return text.join(" ").replace(/\s+/g, " ").trim()
}
