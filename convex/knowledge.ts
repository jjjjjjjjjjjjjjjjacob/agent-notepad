import { query, internalMutation } from "./_generated/server"
import { v, convexToJson, type Value } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import type { QueryCtx } from "./_generated/server"
import { syncWikiGraph } from "./lib/wikiGraph"
import { taskView } from "./lib/views"
import { visibleContribution } from "./lib/channels"
import { publicRevisionAllowed } from "./integrity/access"
import { publicAuthorName } from "./lib/publicAuthor"

async function visibleArticle(ctx: QueryCtx, item: Doc<"resources"> | null) {
  return (
    !!item &&
    item.kind === "wiki" &&
    !!item.currentRevisionId &&
    (await visibleContribution(ctx, item))
  )
}

class KnowledgeReadBudgetExceeded extends Error {}

// Revisions can approach Convex's document limit. Reserve room for the next
// document or bounded metadata page before reading, not just after decoding it.
function knowledgeReads(context: QueryCtx) {
  let bytes = 0,
    reads = 0
  const cached = new Map<string, unknown>()
  const beforeRead = (reserve: number) => {
    if (reads >= 3500 || bytes + reserve > 14 * 1024 * 1024)
      throw new KnowledgeReadBudgetExceeded()
    reads++
  }
  const record = <T>(value: T): T => {
    bytes += new TextEncoder().encode(
      JSON.stringify(convexToJson(value as Value))
    ).byteLength
    return value
  }
  const read = async <T>(load: () => Promise<T>, reserve = 2 * 1024 * 1024) => {
    beforeRead(reserve)
    return record(await load())
  }
  // Shared visibility helpers use db.get. Cache those exact reads without
  // changing their policy or intercepting query-builder methods.
  const db = new Proxy(context.db, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver)
      if (property === "get")
        return async (...args: unknown[]) => {
          const key = String(args.at(-1))
          if (cached.has(key)) return cached.get(key)
          const value = await read(
            () => Promise.resolve(Reflect.apply(method, target, args)),
            1024 * 1024
          )
          cached.set(key, value)
          return value
        }
      return method
    },
  })
  return { ctx: { ...context, db }, read }
}

export const graph = query({
  args: { focus: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (context, args) => {
    const { ctx, read } = knowledgeReads(context)
    const limit = Math.max(
      1,
      Math.min(200, Math.floor(Number.isFinite(args.limit) ? args.limit! : 160))
    )
    const recent = await read(() =>
      ctx.db
        .query("resources")
        .withIndex("by_kind_updated", (q) =>
          q.eq("kind", "wiki").eq("suppressed", false)
        )
        .order("desc")
        .take(limit + 1)
    )
    const selected = new Map<string, Doc<"resources">>()
    const nodes: {
      id: string
      slug: string
      title: string
      topic: string
      excerpt: string
      updatedAt: number
      disputed: boolean
      missing: boolean
      wordCount: number | null
      sourceCount: number | null
      author: string
      taskId: string | null
    }[] = []
    const edges: { source: string; target: string; relationship: string }[] = []
    const missing = new Set<string>()
    let truncated = !args.focus && recent.length > limit
    const visibility = new Map<string, boolean>()
    const visible = async (item: Doc<"resources">) => {
      if (!visibility.has(item._id))
        visibility.set(item._id, await visibleArticle(ctx, item))
      return visibility.get(item._id)!
    }
    const add = async (item: Doc<"resources"> | null) => {
      if (!item || !(await visible(item))) return false
      if (selected.has(item.slug)) return true
      const author = await ctx.db.get(item.authorId)
      nodes.push({
        id: item._id,
        slug: item.slug,
        title: item.title,
        topic: item.topic,
        excerpt: item.excerpt,
        updatedAt: item.updatedAt,
        disputed: item.disputed,
        missing: false,
        wordCount: item.wikiStats?.wordCount ?? null,
        sourceCount: item.wikiStats?.sourceCount ?? null,
        author: publicAuthorName(author),
        taskId: null,
      })
      selected.set(item.slug, item)
      return true
    }
    try {
      const focus = args.focus
        ? await read(() =>
            ctx.db
              .query("resources")
              .withIndex("by_slug", (q) => q.eq("slug", args.focus!))
              .unique()
          )
        : null
      if (focus && (await add(focus))) {
        const incoming = await read(() =>
          ctx.db
            .query("wikiLinks")
            .withIndex("by_target", (q) => q.eq("targetSlug", focus.slug))
            .take(81)
        )
        if (incoming.length > 80) truncated = true
        for (const link of incoming.slice(0, 80))
          await add(await ctx.db.get(link.sourceId))
      } else if (!args.focus)
        for (const item of recent.slice(0, limit)) await add(item)
      const targets = new Map<string, Doc<"resources"> | null>(selected)
      let lookups = 0
      for (const item of [...selected.values()]) {
        const links = await read(() =>
          ctx.db
            .query("wikiLinks")
            .withIndex("by_source", (q) => q.eq("sourceId", item._id))
            .take(101)
        )
        for (const link of links) {
          if (edges.length >= 1600) {
            truncated = true
            break
          }
          if (!targets.has(link.targetSlug)) {
            // Keep the snapshot below Convex's 4,096 index-read limit even for
            // densely linked articles or references to many removed subjects.
            if (selected.size + missing.size >= 260 || lookups >= 800) {
              truncated = true
              continue
            }
            lookups++
            targets.set(
              link.targetSlug,
              await read(() =>
                ctx.db
                  .query("resources")
                  .withIndex("by_slug", (q) => q.eq("slug", link.targetSlug))
                  .unique()
              )
            )
          }
          const target = targets.get(link.targetSlug)
          // An existing hidden target is not a missing subject.
          if (target && !(await add(target))) continue
          if (!target && !missing.has(link.targetSlug)) {
            const task = await read(() =>
              ctx.db
                .query("tasks")
                .withIndex("by_dedupe", (q) =>
                  q.eq("dedupeKey", `wiki-gap:${link.targetSlug}`)
                )
                .unique()
            )
            const visibleTask =
              task && ["open", "leased"].includes(task.status)
                ? await taskView(ctx, task)
                : null
            nodes.push({
              id: `missing:${link.targetSlug}`,
              slug: link.targetSlug,
              title: link.label,
              topic: item.topic,
              excerpt:
                "This subject is referenced by the wiki and needs an article.",
              updatedAt: 0,
              disputed: false,
              missing: true,
              wordCount: null,
              sourceCount: null,
              author: "",
              taskId: visibleTask ? task!._id : null,
            })
            missing.add(link.targetSlug)
          }
          edges.push({
            source: item.slug,
            target: link.targetSlug,
            relationship: link.relationship,
          })
        }
      }
    } catch (error) {
      if (!(error instanceof KnowledgeReadBudgetExceeded)) throw error
      truncated = true
    }
    return {
      nodes,
      edges,
      truncated,
      scope: args.focus ? "neighborhood" : "recent",
      generatedAt: Date.now(),
    }
  },
})

export const gap = query({
  args: { slug: v.string() },
  handler: async (context, { slug }) => {
    const { ctx, read } = knowledgeReads(context)
    const sources: { title: string; slug: string }[] = []
    let title = "",
      taskId: string | null = null
    try {
      if (
        await read(() =>
          ctx.db
            .query("resources")
            .withIndex("by_slug", (q) => q.eq("slug", slug))
            .unique()
        )
      )
        return null
      const incoming = await read(() =>
        ctx.db
          .query("wikiLinks")
          .withIndex("by_target", (q) => q.eq("targetSlug", slug))
          .take(40)
      )
      for (const link of incoming) {
        const source = await ctx.db.get(link.sourceId)
        if (!source || !(await visibleArticle(ctx, source))) continue
        title ||= link.label
        sources.push({ title: source.title, slug: source.slug })
      }
      if (!sources.length) return null
      const task = await read(() =>
        ctx.db
          .query("tasks")
          .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `wiki-gap:${slug}`))
          .unique()
      )
      if (
        task &&
        ["open", "leased"].includes(task.status) &&
        (await taskView(ctx, task))
      )
        taskId = task._id
    } catch (error) {
      if (!(error instanceof KnowledgeReadBudgetExceeded)) throw error
    }
    // This endpoint already returns a bounded source sample. Keep validated
    // sources if the byte budget ends before the remaining metadata is read.
    return sources.length ? { title, sources, taskId } : null
  },
})

export const details = query({
  args: { slug: v.string() },
  handler: async (context, { slug }) => {
    const { ctx, read } = knowledgeReads(context)
    const item = await read(() =>
      ctx.db
        .query("resources")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    )
    if (!item || !(await visibleArticle(ctx, item))) return null
    const activity: {
      id: string
      summary: string
      createdAt: number
      author: string
    }[] = []
    const tasks: { id: string; title: string; type: string; status: string }[] =
      []
    try {
      const revisions = await read(
        () =>
          ctx.db
            .query("revisions")
            .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
            .order("desc")
            .take(6),
        6 * 1024 * 1024
      )
      for (const revision of revisions) {
        if (
          !publicRevisionAllowed(item, revision) ||
          revision.status !== "published"
        )
          continue
        activity.push({
          id: revision._id,
          summary: revision.summary,
          createdAt: revision._creationTime,
          author: publicAuthorName(await ctx.db.get(revision.authorId)),
        })
      }
      const related = await read(
        () =>
          ctx.db
            .query("tasks")
            .withIndex("by_target", (q) => q.eq("targetId", item._id))
            .order("desc")
            .take(80),
        4 * 1024 * 1024
      )
      for (const task of related) {
        if (!["open", "leased"].includes(task.status)) continue
        const visible = await taskView(ctx, task)
        if (visible)
          tasks.push({
            id: visible.id,
            title: visible.title,
            type: visible.type,
            status: visible.status,
          })
      }
    } catch (error) {
      if (!(error instanceof KnowledgeReadBudgetExceeded)) throw error
    }
    return { activity, tasks }
  },
})

// Bounded backfill for pre-existing articles; does not manufacture new editorial work.
export const backfill = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("resources")
      .withIndex("by_kind_updated", (q) =>
        q.eq("kind", "wiki").eq("suppressed", false)
      )
      .paginate({ cursor: args.cursor ?? null, numItems: 30 })
    for (const item of page.page) {
      const rev = item.currentRevisionId
        ? await ctx.db.get(item.currentRevisionId)
        : null
      if (rev && !(rev.suppressed || rev.quarantined))
        await syncWikiGraph(ctx, item, rev, false)
    }
    return {
      cursor: page.isDone ? null : page.continueCursor,
      count: page.page.length,
    }
  },
})
