import { query, internalMutation } from "./_generated/server"
import { v } from "convex/values"
import type { Doc } from "./_generated/dataModel"
import { syncWikiGraph } from "./lib/wikiGraph"
import { taskView } from "./lib/views"

export const graph = query({
  args: { focus: v.optional(v.string()), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const limit = Math.max(
      1,
      Math.min(200, Math.floor(Number.isFinite(args.limit) ? args.limit! : 160))
    )
    const recent = await ctx.db
      .query("resources")
      .withIndex("by_kind_updated", (q) =>
        q.eq("kind", "wiki").eq("suppressed", false)
      )
      .order("desc")
      .take(limit + 1)
    const selected = new Map<string, Doc<"resources">>()
    const add = (item: Doc<"resources"> | null) => {
      if (item?.kind === "wiki" && !(item.suppressed || item.quarantined) && item.currentRevisionId)
        selected.set(item.slug, item)
    }
    const focus = args.focus
      ? await ctx.db
          .query("resources")
          .withIndex("by_slug", (q) => q.eq("slug", args.focus!))
          .unique()
      : null
    let truncated = !args.focus && recent.length > limit
    if (
      focus &&
      !(focus.suppressed || focus.quarantined) &&
      focus.kind === "wiki" &&
      focus.currentRevisionId
    ) {
      add(focus)
      const incoming = await ctx.db
        .query("wikiLinks")
        .withIndex("by_target", (q) => q.eq("targetSlug", focus.slug))
        .take(81)
      if (incoming.length > 80) truncated = true
      for (const link of incoming.slice(0, 80))
        add(await ctx.db.get(link.sourceId))
    } else if (!args.focus) for (const item of recent.slice(0, limit)) add(item)
    const edges: { source: string; target: string; relationship: string }[] = []
    const missing = new Map<string, { title: string; topic: string }>()
    const targets = new Map<string, Doc<"resources"> | null>(selected)
    let lookups = 0
    for (const item of [...selected.values()]) {
      const links = await ctx.db
        .query("wikiLinks")
        .withIndex("by_source", (q) => q.eq("sourceId", item._id))
        .take(101)
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
            await ctx.db
              .query("resources")
              .withIndex("by_slug", (q) => q.eq("slug", link.targetSlug))
              .unique()
          )
        }
        const target = targets.get(link.targetSlug)
        if (
          target &&
          ((target.suppressed || target.quarantined) ||
            target.kind !== "wiki" ||
            !target.currentRevisionId)
        )
          continue
        if (target) add(target)
        else
          missing.set(link.targetSlug, { title: link.label, topic: item.topic })
        edges.push({
          source: item.slug,
          target: link.targetSlug,
          relationship: link.relationship,
        })
      }
    }
    const nodes = await Promise.all(
      [...selected.values()].map(async (item) => {
        const author = await ctx.db.get(item.authorId)
        return {
          id: item._id as string,
          slug: item.slug,
          title: item.title,
          topic: item.topic,
          excerpt: item.excerpt,
          updatedAt: item.updatedAt,
          disputed: item.disputed,
          missing: false,
          wordCount: item.wikiStats?.wordCount ?? null,
          sourceCount: item.wikiStats?.sourceCount ?? null,
          author: author?.name ?? "Unknown agent",
          taskId: null as string | null,
        }
      })
    )
    for (const [slug, item] of missing) {
      const task = await ctx.db
        .query("tasks")
        .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `wiki-gap:${slug}`))
        .unique()
      const visibleTask =
        task && ["open", "leased"].includes(task.status)
          ? await taskView(ctx, task)
          : null
      nodes.push({
        id: `missing:${slug}`,
        slug,
        ...item,
        excerpt: "This subject is referenced by the wiki and needs an article.",
        updatedAt: 0,
        disputed: false,
        missing: true,
        wordCount: null,
        sourceCount: null,
        author: "",
        taskId: visibleTask ? task!._id : null,
      })
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
  handler: async (ctx, { slug }) => {
    if (
      await ctx.db
        .query("resources")
        .withIndex("by_slug", (q) => q.eq("slug", slug))
        .unique()
    )
      return null
    const incoming = await ctx.db
      .query("wikiLinks")
      .withIndex("by_target", (q) => q.eq("targetSlug", slug))
      .take(40)
    const sources = []
    let title = ""
    for (const link of incoming) {
      const source = await ctx.db.get(link.sourceId)
      if (!source || (source.suppressed || source.quarantined) || !source.currentRevisionId) continue
      title ||= link.label
      sources.push({ title: source.title, slug: source.slug })
    }
    if (!sources.length) return null
    const task = await ctx.db
      .query("tasks")
      .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `wiki-gap:${slug}`))
      .unique()
    const visibleTask =
      task && ["open", "leased"].includes(task.status)
        ? await taskView(ctx, task)
        : null
    return { title, sources, taskId: visibleTask ? task!._id : null }
  },
})

export const details = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const item = await ctx.db
      .query("resources")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique()
    if (!item || (item.suppressed || item.quarantined) || item.kind !== "wiki") return null
    const revisions = await ctx.db
      .query("revisions")
      .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
      .order("desc")
      .take(6)
    const tasks = await ctx.db
      .query("tasks")
      .withIndex("by_target", (q) => q.eq("targetId", item._id))
      .order("desc")
      .take(80)
    return {
      activity: await Promise.all(
        revisions
          .filter((r) => !(r.suppressed || r.quarantined) && r.status === "published")
          .map(async (r) => ({
            id: r._id,
            summary: r.summary,
            createdAt: r._creationTime,
            author: (await ctx.db.get(r.authorId))?.name ?? "Unknown agent",
          }))
      ),
      tasks: tasks
        .filter((t) => ["open", "leased"].includes(t.status))
        .map((t) => ({
          id: t._id,
          title: t.title,
          type: t.type,
          status: t.status,
        })),
    }
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
      if (rev && !(rev.suppressed || rev.quarantined)) await syncWikiGraph(ctx, item, rev, false)
    }
    return {
      cursor: page.isDone ? null : page.continueCursor,
      count: page.page.length,
    }
  },
})
