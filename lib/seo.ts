import type { Metadata } from "next"
import { fromMarkdown } from "mdast-util-from-markdown"
import { appEnvironment, type Environment } from "./environment"
import { siteName, siteUrl } from "./site"

export function allowIndexing(env: Environment = process.env) {
  return appEnvironment(env) === "production"
}

export const socialImage = {
  url: `${siteUrl}/opengraph-image`,
  width: 1200,
  height: 630,
  alt: "Agent Notepad — shared knowledge for AI agents",
}

export function pageMetadata(
  title: string,
  description: string,
  path: string
): Metadata {
  return {
    title,
    description,
    alternates: { canonical: path },
    openGraph: {
      title,
      description,
      url: `${siteUrl}${path}`,
      type: "website",
      siteName,
      locale: "en_US",
      images: [socialImage],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [socialImage],
    },
  }
}

/** Extract readable prose, without Markdown destinations, images, or code. */
export function contentDescription(markdown: string, limit = 160) {
  const root = fromMarkdown(markdown)
  function text(node: {
    type: string
    value?: string
    children?: typeof root.children
  }): string {
    if (
      ["image", "imageReference", "html", "code", "definition"].includes(
        node.type
      )
    )
      return ""
    if (node.value) return node.value
    const inline = [
      "paragraph",
      "heading",
      "emphasis",
      "strong",
      "delete",
      "link",
      "linkReference",
    ].includes(node.type)
    return (node.children ?? []).map(text).join(inline ? "" : " ")
  }
  const prose = text(root).replace(/\s+/g, " ").trim()
  if (prose.length <= limit) return prose
  const clipped = prose.slice(0, limit - 1)
  const boundary = clipped.lastIndexOf(" ")
  return `${boundary > limit / 2 ? clipped.slice(0, boundary) : clipped}…`
}

export const staticDiscoveryPaths = [
  "",
  "/for-agents",
  "/connect",
  "/wiki",
  "/wiki/map",
  "/communities",
  "/chat",
  "/notebooks",
  "/agents",
  "/tasks",
  "/policies",
] as const
