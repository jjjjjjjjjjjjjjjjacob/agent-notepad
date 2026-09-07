import { readFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { parseArticleMarkdown } from "../lib/article-markdown"
import type { RootContent } from "mdast"
import { commandSchemas } from "../lib/contracts"
import { articleStats, wikiLinks } from "../lib/wiki-content"
import manifest from "../content/wiki/manifest.json"

const apply = process.argv.includes("--apply")
const base = (process.env.WIKI_SITE_URL ?? "http://localhost:3843").replace(
  /\/$/,
  ""
)
const sourceTitles: Record<string, string> = manifest.sources
const articles = await Promise.all(
  manifest.articles.map(async (article) => {
    const body = await readFile(
      new URL(`../content/wiki/${article.slug}.md`, import.meta.url),
      "utf8"
    )
    const urls = new Set<string>()
    const walk = (nodes: RootContent[]) => {
      for (const node of nodes) {
        if (node.type === "link" && sourceTitles[node.url]) urls.add(node.url)
        if ("children" in node) walk(node.children as RootContent[])
      }
    }
    const nodes = parseArticleMarkdown(body).children.flatMap((node) =>
      node.type === "code" && node.lang === "infobox"
        ? parseArticleMarkdown(node.value).children
        : [node]
    )
    walk(nodes)
    const input = commandSchemas.publish.parse({
      ...article,
      kind: "wiki",
      body,
      citations: [...urls].map((url) => ({ url, title: sourceTitles[url] })),
      summary:
        "Update sourced coverage, infoboxes, article sections, and related subjects",
    })
    console.log(
      `${article.slug}: ${articleStats(body, urls.size).wordCount} words · ${urls.size} sources · ${wikiLinks(body).length} connections`
    )
    return input
  })
)
if (!apply) {
  console.log(
    "Validated bundle. Pass --apply with WIKI_AGENT_KEY (or WIKI_CREDENTIAL_FILE) to publish to the selected development/test site."
  )
} else {
  const health = await fetch(`${base}/health`).then((r) => r.json())
  if (!["development", "test"].includes(health.environment))
    throw new Error(
      "This bundle publisher only targets development or isolated test environments."
    )
  const credentials = process.env.WIKI_CREDENTIAL_FILE
    ? JSON.parse(await readFile(process.env.WIKI_CREDENTIAL_FILE, "utf8"))
    : null
  const token =
    process.env.WIKI_AGENT_KEY ??
    credentials?.data?.apiKey ??
    credentials?.apiKey
  if (!token) throw new Error("Provide WIKI_AGENT_KEY or WIKI_CREDENTIAL_FILE.")
  const command = async (operation: string, input: unknown) => {
    const body = JSON.stringify(input)
    const response = await fetch(`${base}/api/v1/commands/${operation}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `wiki-bundle-${operation}-${createHash("sha256").update(body).digest("hex").slice(0, 32)}`,
      },
      body,
    })
    const result = await response.json()
    if (!response.ok)
      throw new Error(
        `${operation}: ${result.error?.code}: ${result.error?.message}`
      )
    return result.data
  }
  const ids = new Map<string, string>()
  for (const article of articles) {
    const response = await fetch(`${base}/api/v1/resources/${article.slug}`)
    if (response.status !== 404 && !response.ok)
      throw new Error(`Cannot read ${article.slug}: ${response.status}`)
    const current = response.ok ? (await response.json()).data : null
    if (current && current.kind !== "wiki")
      throw new Error(
        `${article.slug} is already used by a different contribution type.`
      )
    if (
      current?.revision.body === article.body &&
      JSON.stringify(current.revision.citations) ===
        JSON.stringify(article.citations)
    ) {
      ids.set(article.slug!, current.id)
      console.log(`Unchanged: ${article.slug}`)
      continue
    }
    const result = current
      ? await command("edit", {
          id: current.id,
          baseRevisionId: current.revision.id,
          title: article.title,
          body: article.body,
          citations: article.citations,
          summary: article.summary,
          attachmentIds: current.files.map((f: { id: string }) => f.id),
        })
      : await command("publish", article)
    ids.set(article.slug!, result.id)
    console.log(`Published: ${article.slug} · revision ${result.revisionId}`)
  }
  for (const work of manifest.work) {
    await command("raise_issue", {
      type: "knowledge_gap",
      resourceId: ids.get(work.slug),
      description: work.description,
    })
    console.log(`Requested expansion: ${work.slug}`)
  }
}
