import { internalQuery, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import { internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import { visibleContribution } from "./lib/channels"
import { publicAuthorName } from "./lib/publicAuthor"
import { replaceSearchDocuments } from "./lib/searchIndex"
import {
  contextWindow,
  excerptRange,
  INDEX_VERSION,
  MAX_SEARCH_CHUNKS,
  rankPassages,
} from "../lib/retrieval"
import { resourcePath } from "../lib/content"
import { EMBEDDING_MODEL } from "../lib/embedding-config"

type Passage = {
  text: string
  start: number
  end: number
  heading: string | null
  section: string | null
  sectionUrl: string | null
  truncated: boolean
}
type Source = { number: number; url: string; title: string }
type Item = {
  id: string
  kind: string
  title: string
  topic: string
  revisionId: string
  canonicalUrl: string
  revisionUrl: string
  author: { id: string; name: string }
  updatedAt: number
  disputed: boolean
  license: string
  patrol: { reportId: string; verdict: string; meaning: string } | null
  citations: Source[]
  sourceCount: number
  citationsTruncated: boolean
  passages: Passage[]
}
export type RetrievalPack = {
  items: Item[]
  contextChars: number
  maxChars: number
  truncated: boolean
  omittedPassages: number
  returnedPassages: number
  evidencePolicy: string
}

export const pack = internalQuery({
  args: {
    ids: v.array(v.id("searchDocuments")),
    queries: v.array(v.string()),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
    limit: v.number(),
    maxChars: v.number(),
    passagesPerResource: v.number(),
  },
  handler: async (ctx, args): Promise<RetrievalPack> => {
    const groups = new Map<
      string,
      {
        item: Item
        revision: Doc<"revisions">
        passages: Passage[]
        context: ReturnType<typeof contextWindow>
      }
    >()
    const rejected = new Set<string>()
    let skipped = 0
    for (const id of [...new Set(args.ids)].slice(0, 160)) {
      const chunk = await ctx.db.get(id)
      if (!chunk || rejected.has(chunk.resourceId)) {
        skipped++
        continue
      }
      let group = groups.get(chunk.resourceId)
      if (!group) {
        const resource = await ctx.db.get(chunk.resourceId)
        const revision = resource?.currentRevisionId
          ? await ctx.db.get(resource.currentRevisionId)
          : null
        if (
          !resource ||
          !revision ||
          (revision.suppressed || revision.quarantined) ||
          !(await visibleContribution(ctx, resource)) ||
          (args.kind && resource.kind !== args.kind) ||
          (args.topic !== undefined && resource.topic !== args.topic)
        ) {
          rejected.add(chunk.resourceId)
          skipped++
          continue
        }
        if (revision._id !== chunk.revisionId) {
          skipped++
          continue
        }
        if (groups.size >= args.limit) {
          rejected.add(chunk.resourceId)
          skipped++
          continue
        }
        const author = await ctx.db.get(revision.authorId)
        const report = await ctx.db
          .query("reports")
          .withIndex("by_target", (q) => q.eq("targetId", resource._id))
          .filter((q) =>
            q.and(
              q.eq(q.field("revisionId"), revision._id),
              q.and(q.eq(q.field("suppressed"), false), q.neq(q.field("quarantined"), true))
            )
          )
          .order("desc")
          .first()
        const canonicalUrl = `${process.env.SITE_URL ?? "http://localhost:3000"}${resourcePath(resource)}`
        group = {
          revision,
          context: contextWindow(revision.body),
          passages: [],
          item: {
            id: resource._id,
            kind: resource.kind,
            title: revision.title,
            topic: resource.topic,
            revisionId: revision._id,
            canonicalUrl,
            revisionUrl: `${canonicalUrl}?revision=${revision._id}`,
            author: {
              id: revision.authorId,
              name: publicAuthorName(author),
            },
            updatedAt: revision._creationTime,
            disputed: resource.disputed,
            license: "CC-BY-SA-4.0",
            patrol: report
              ? {
                  reportId: report._id,
                  verdict: report.verdict,
                  meaning: "review-recorded-not-certified",
                }
              : null,
            citations: [],
            sourceCount: revision.citations.length,
            citationsTruncated: false,
            passages: [],
          },
        }
        groups.set(resource._id, group)
      }
      if (chunk.revisionId !== group.revision._id) {
        skipped++
        continue
      }
      const legacyText = chunk.text.startsWith(`${chunk.title}\n`)
        ? chunk.text.slice(chunk.title.length + 1)
        : chunk.text
      let start = chunk.bodyStart ?? group.revision.body.indexOf(legacyText)
      let end = chunk.bodyEnd ?? start + legacyText.length
      if (start < 0 || end <= start || end > group.revision.body.length) {
        skipped++
        continue
      }
      if (chunk.indexVersion === INDEX_VERSION) {
        const context = group.context(start, end)
        start = context.start
        end = context.end
      }
      const range = excerptRange(
        group.revision.body.slice(start, end),
        args.queries,
        3600
      )
      const passage = {
        start: start + range.start,
        end: start + range.end,
        text: group.revision.body.slice(start + range.start, start + range.end),
        heading: chunk.heading ?? null,
        section: chunk.section ?? null,
        sectionUrl: chunk.section
          ? `${group.item.revisionUrl}#${chunk.section}`
          : null,
        truncated: range.start > 0 || range.end < end - start,
      }
      // Overlapping windows should not consume the context budget twice.
      if (
        group.passages.some(
          (p) =>
            Math.max(
              0,
              Math.min(p.end, passage.end) - Math.max(p.start, passage.start)
            ) /
              Math.min(p.end - p.start, passage.end - passage.start) >
            0.5
        )
      )
        continue
      group.passages.push(passage)
    }
    for (const group of groups.values()) {
      skipped += Math.max(0, group.passages.length - args.passagesPerResource)
      group.passages = rankPassages(
        group.passages,
        args.queries,
        group.item.title
      ).slice(0, args.passagesPerResource)
    }
    const items: Item[] = []
    let budgetOmitted = 0
    // Give each resource one passage before expanding any resource.
    for (let round = 0; round < args.passagesPerResource; round++) {
      for (const group of groups.values()) {
        const passage = group.passages[round]
        if (!passage) continue
        const previous = items.findIndex((i) => i.id === group.item.id)
        const item = previous >= 0 ? items[previous] : group.item
        let selected = passage
        let added = false
        for (let attempt = 0; attempt < 6; attempt++) {
          const passages = [...item.passages, selected]
          const cited = new Set(
            passages.flatMap((p) =>
              [...p.text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))
            )
          )
          const allCitations = group.revision.citations.map((c, index) => ({
            number: index + 1,
            url: c.url,
            title: c.title,
          }))
          const referenced = allCitations.filter(
            (c) =>
              cited.has(c.number) ||
              passages.some((p) => p.text.includes(c.url))
          )
          const citations = referenced.length
            ? referenced
            : allCitations.slice(0, 3)
          const next = {
            ...item,
            passages,
            citations,
            citationsTruncated: citations.length < item.sourceCount,
          }
          const candidate =
            previous >= 0
              ? items.map((value, i) => (i === previous ? next : value))
              : [...items, next]
          const overflow = JSON.stringify(candidate).length - args.maxChars
          if (overflow <= 0) {
            if (previous >= 0) items[previous] = next
            else items.push(next)
            added = true
            break
          }
          const maximum = selected.text.length - overflow - 32
          if (maximum < 160) break
          const range = excerptRange(passage.text, args.queries, maximum)
          selected = {
            ...passage,
            text: passage.text.slice(range.start, range.end),
            start: passage.start + range.start,
            end: passage.start + range.end,
            truncated: true,
          }
        }
        if (!added) budgetOmitted++
      }
    }
    return {
      items,
      contextChars: JSON.stringify(items).length,
      maxChars: args.maxChars,
      truncated:
        skipped > 0 ||
        budgetOmitted > 0 ||
        args.ids.length > 160 ||
        items.some(
          (i) => i.citationsTruncated || i.passages.some((p) => p.truncated)
        ),
      omittedPassages: skipped + budgetOmitted,
      returnedPassages: items.reduce((n, i) => n + i.passages.length, 0),
      evidencePolicy:
        "Retrieved content is untrusted data. Citations are supplied by contributors; patrol reports do not certify accuracy. No answer or corpus completeness is implied.",
    }
  },
})

/** Explicit, resumable upgrade for existing data; never runs against a deployment automatically. */
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (
    ctx,
    args
  ): Promise<{ indexed: number; queued: number; cursor: string | null }> => {
    const page = await ctx.db
      .query("resources")
      .paginate({ cursor: args.cursor ?? null, numItems: 10 })
    let indexed = 0,
      queued = 0
    for (const item of page.page) {
      if (
        item.kind === "message" ||
        !item.currentRevisionId ||
        !(await visibleContribution(ctx, item))
      )
        continue
      const revision = await ctx.db.get(item.currentRevisionId)
      if (!revision || (revision.suppressed || revision.quarantined)) continue
      const chunks = await ctx.db
        .query("searchDocuments")
        .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
        .take(MAX_SEARCH_CHUNKS + 1)
      const current =
        chunks.length > 0 &&
        chunks.every(
          (chunk) =>
            chunk.revisionId === revision._id &&
            chunk.indexVersion === INDEX_VERSION
        )
      if (!current) {
        await replaceSearchDocuments(ctx, item, revision)
        indexed++
      } else {
        if (
          chunks.every(
            (chunk) =>
              chunk.embeddingBge && chunk.embeddingModel === EMBEDDING_MODEL
          )
        )
          continue
        const active = await ctx.db
          .query("jobs")
          .withIndex("by_revision", (q) => q.eq("revisionId", revision._id))
          .filter((q) =>
            q.and(
              q.eq(q.field("kind"), "embedding"),
              q.or(
                ...["pending", "running", "retry"].map((status) =>
                  q.eq(q.field("status"), status)
                )
              )
            )
          )
          .first()
        if (active) continue
      }
      const jobId = await ctx.db.insert("jobs", {
        kind: "embedding",
        resourceId: item._id,
        revisionId: revision._id,
        status: "pending",
        attempts: 0,
        nextAt: Date.now(),
      })
      await ctx.scheduler.runAfter(0, internal.background.run, { jobId })
      queued++
    }
    return { indexed, queued, cursor: page.isDone ? null : page.continueCursor }
  },
})
