import { query, internalQuery } from "./_generated/server"
import { v } from "convex/values"
import { card } from "./lib/views"
import type { QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { resourcePath, headingId } from "../lib/content"
import { visibleContribution } from "./lib/channels"
import { excerptRange, SEARCH_CANDIDATES, keywordTerms } from "../lib/retrieval"
async function result(
  ctx: QueryCtx,
  resource: Doc<"resources">,
  chunk: Doc<"searchDocuments">,
  query = ""
) {
  const revision = await ctx.db.get(chunk.revisionId)
  const report = await ctx.db
    .query("reports")
    .withIndex("by_target", (q) => q.eq("targetId", resource._id))
    .filter((q) =>
      q.and(
        q.eq(q.field("revisionId"), chunk.revisionId),
        q.and(q.eq(q.field("suppressed"), false), q.neq(q.field("quarantined"), true))
      )
    )
    .first()
  const canonicalUrl = `${process.env.SITE_URL ?? "http://localhost:3000"}${resourcePath(resource)}`
  const heading = /^#{1,6}\s+(.+)$/m.exec(chunk.text)?.[1]
  const excerpt = excerptRange(chunk.text, [query], 1200)
  return {
    ...(await card(ctx, resource)),
    passage: chunk.text.slice(excerpt.start, excerpt.end),
    canonicalUrl,
    revisionUrl: `${canonicalUrl}?revision=${chunk.revisionId}`,
    sectionUrl: heading
      ? `${canonicalUrl}?revision=${chunk.revisionId}#${headingId(heading)}`
      : null,
    sourceUrls: revision?.citations.slice(0, 5).map((c) => c.url) ?? [],
    license: "CC-BY-SA-4.0",
    patrol: report
      ? {
          reportId: report._id,
          verdict: report.verdict,
          meaning: "review-recorded-not-certified",
        }
      : null,
  }
}
export const keyword = query({
  args: {
    query: v.string(),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const query = args.query.trim().slice(0, 300)
    if (!query || (args.kind && !["wiki", "post", "note"].includes(args.kind)))
      return []
    const chunks = await ctx.db
      .query("searchDocuments")
      .withSearchIndex("text", (q) => {
        let search = q.search("text", query)
        if (args.kind && ["wiki", "post", "note"].includes(args.kind))
          search = search.eq("kind", args.kind as "wiki")
        if (args.topic) search = search.eq("topic", args.topic)
        return search
      })
      .take(40)
    const seen = new Set<string>()
    const items = []
    for (const chunk of chunks) {
      if (seen.has(chunk.resourceId)) continue
      const resource = await ctx.db.get(chunk.resourceId)
      if (
        !resource ||
        !(await visibleContribution(ctx, resource)) ||
        resource.currentRevisionId !== chunk.revisionId ||
        (await ctx.db.get(chunk.revisionId))?.suppressed !== false
      )
        continue
      seen.add(resource._id)
      items.push(await result(ctx, resource, chunk, query))
    }
    return items.slice(0, 20)
  },
})
export const hydrateVector = internalQuery({
  args: { ids: v.array(v.id("searchDocuments")) },
  handler: async (ctx, args) => {
    const items = []
    const seen = new Set<string>()
    for (const id of args.ids.slice(0, 40)) {
      const chunk = await ctx.db.get(id)
      const resource = chunk ? await ctx.db.get(chunk.resourceId) : null
      if (
        !chunk ||
        !resource ||
        !(await visibleContribution(ctx, resource)) ||
        resource.currentRevisionId !== chunk.revisionId ||
        (await ctx.db.get(chunk.revisionId))?.suppressed !== false ||
        seen.has(resource._id)
      )
        continue
      seen.add(resource._id)
      items.push(await result(ctx, resource, chunk))
    }
    return items
  },
})

export const candidates = internalQuery({
  args: {
    query: v.string(),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const lookup = async (query: string) =>
      (
        await ctx.db
          .query("searchDocuments")
          .withSearchIndex("text", (q) => {
            let search = q.search("text", query)
            if (args.kind) search = search.eq("kind", args.kind as "wiki")
            if (args.topic !== undefined)
              search = search.eq("topic", args.topic)
            return search
          })
          .take(SEARCH_CANDIDATES)
      ).map((chunk) => ({ id: chunk._id, resourceId: chunk.resourceId }))
    const terms = keywordTerms(args.query)
    // Full-text search matches any term; avoid letting question words dominate recall.
    return lookup(terms.length ? terms.join(" ") : args.query)
  },
})
