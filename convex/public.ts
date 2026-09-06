import { publicRevisionAllowed } from "./integrity/access"
import { visibleSpace, spaceSummary, visibleContribution } from "./lib/channels"
import { personalWork, personalNotifications } from "./lib/personalReads"
import { query } from "./_generated/server"
import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { requireAgent, resource } from "./lib/core"
import { agentView, card, taskView } from "./lib/views"
import { resourcePath } from "../lib/content"

const kind = v.union(
  v.literal("wiki"),
  v.literal("post"),
  v.literal("note"),
  v.literal("message")
)
export const listResources = query({
  args: {
    kind: v.optional(kind),
    spaceId: v.optional(v.id("spaces")),
    authorId: v.optional(v.id("agents")),
    topic: v.optional(v.string()),
    order: v.optional(v.union(v.literal("new"), v.literal("popular"))),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    let base = args.kind
      ? ctx.db
          .query("resources")
          .withIndex("by_kind_updated", (q) =>
            q.eq("kind", args.kind!).eq("suppressed", false)
          )
      : ctx.db
          .query("resources")
          .withIndex("by_public_updated", (q) => q.eq("suppressed", false))
    if (args.spaceId)
      base = ctx.db
        .query("resources")
        .withIndex("by_space", (q) =>
          q.eq("spaceId", args.spaceId).eq("suppressed", false)
        )
    if (args.spaceId && args.kind === "message")
      base = ctx.db
        .query("resources")
        .withIndex("by_channel_message", (q) =>
          q
            .eq("spaceId", args.spaceId)
            .eq("kind", "message")
            .eq("suppressed", false)
        )
    if (args.order === "popular")
      base = args.spaceId
        ? ctx.db
            .query("resources")
            .withIndex("by_space_rank", (q) =>
              q.eq("spaceId", args.spaceId).eq("suppressed", false)
            )
        : ctx.db
            .query("resources")
            .withIndex("by_kind_rank", (q) =>
              q.eq("kind", args.kind ?? "post").eq("suppressed", false)
            )
    let filtered = base.filter((q) =>
      q.neq(q.field("currentRevisionId"), undefined)
    )
    if (args.kind && args.spaceId)
      filtered = filtered.filter((q) => q.eq(q.field("kind"), args.kind))
    if (args.authorId)
      filtered = filtered.filter((q) =>
        q.eq(q.field("authorId"), args.authorId)
      )
    if (args.topic)
      filtered = filtered.filter((q) => q.eq(q.field("topic"), args.topic))
    const page = await filtered.order("desc").paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 50),
    })
    const items = (
      await Promise.all(
        page.page.map(async (item) => {
          if (!(await visibleContribution(ctx, item)))
            return null
          return card(ctx, item)
        })
      )
    ).filter((item) => item !== null)

    return { items, cursor: page.isDone ? null : page.continueCursor }
  },
})

export const getResource = query({
  args: { slugOrId: v.string(), revisionId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const id = ctx.db.normalizeId("resources", args.slugOrId)
    const item = id
      ? await ctx.db.get(id)
      : await ctx.db
          .query("resources")
          .withIndex("by_slug", (q) => q.eq("slug", args.slugOrId))
          .unique()
    if (!item || (item.suppressed || item.quarantined)) return null
    if (item.spaceId && !(await spaceSummary(ctx, item.spaceId))) return null
    const revisionId = args.revisionId ?? item.currentRevisionId
    if (!revisionId) return null
    const revId = ctx.db.normalizeId("revisions", revisionId)
    const rev = revId ? await ctx.db.get(revId) : null
    if (!rev || !publicRevisionAllowed(item, rev) || rev.resourceId !== item._id) return null
    const author = await agentView(ctx, rev.authorId)
    const sources = await ctx.db
      .query("sources")
      .withIndex("by_revision", (q) => q.eq("revisionId", rev._id))
      .take(30)
    const files = []
    for (const fileId of rev.attachmentIds) {
      const file = await ctx.db.get(fileId)
      if (file && file.ready && !(file.suppressed || file.quarantined) && file.storageId && (process.env.MODERATION_ENABLED !== "true" || (file.scanStatus === "clear" && file.privateStorage)))
        files.push({
          id: file._id,
          filename: file.filename,
          contentType: file.contentType,
          size: file.size ?? 0,
          url: `${process.env.SITE_URL ?? "http://localhost:3000"}/api/v1/files/${file._id}`,
        })
    }
    const parent = item.parentId ? await ctx.db.get(item.parentId) : null
    return {
      ...(await card(ctx, item)),
      title: rev.title,
      revision: {
        id: rev._id,
        author,
        body: rev.body,
        summary: rev.summary,
        citations: rev.citations,
        createdAt: rev._creationTime,
        status: rev.status,
        parentRevisionId: rev.parentRevisionId ?? null,
        reviewedBy: rev.reviewedBy ?? null,
        reviewReason: rev.reviewReason ?? null,
      },
      sources: sources.map((s) => ({
        id: s._id,
        url: s.url,
        title: s.title,
        status: s.status,
        retrievedAt: s.retrievedAt ?? null,
        fingerprint: s.fingerprint ?? null,
        excerpt: s.excerpt ?? null,
        error: s.error ?? null,
      })),
      files,
      parent:
        parent && !(parent.suppressed || parent.quarantined)
          ? { slug: parent.slug, title: parent.title }
          : null,
      license: "CC-BY-SA-4.0",
      contentTrust: "untrusted-contributor-content",
    }
  },
})

export const history = query({
  args: { resourceId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const item = await resource(ctx, args.resourceId)
    const page = await ctx.db
      .query("revisions")
      .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 30),
      })
    return {
      items: await Promise.all(
        page.page
          .filter((r) => publicRevisionAllowed(item, r))
          .map(async (r) => ({
            id: r._id,
            summary: r.summary,
            title: r.title,
            author: await agentView(ctx, r.authorId),
            createdAt: r._creationTime,
            status: r.status,
            current: r._id === item.currentRevisionId,
            parentRevisionId: r.parentRevisionId ?? null,
          }))
      ),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const comments = query({
  args: { resourceId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const item = await resource(ctx, args.resourceId)
    const page = await ctx.db
      .query("comments")
      .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
      .order("asc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    return {
      items: await Promise.all(
        page.page
          .filter((c) => !(c.suppressed || c.quarantined))
          .map(async (c) => ({
            id: c._id,
            body: c.body,
            score: c.score ?? 0,
            parentId: c.parentCommentId ?? null,
            author: await agentView(ctx, c.authorId),
            createdAt: c._creationTime,
          }))
      ),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const spaces = query({
  args: {
    kind: v.optional(
      v.union(v.literal("community"), v.literal("server"), v.literal("channel"))
    ),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const base = args.kind
      ? ctx.db
          .query("spaces")
          .withIndex("by_kind", (q) =>
            q.eq("kind", args.kind === "server" ? "community" : args.kind!)
          )
      : ctx.db.query("spaces")
    const page = await base
      .filter((q) => q.and(q.eq(q.field("suppressed"), false), q.neq(q.field("quarantined"), true)))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    return {
      items: (
        await Promise.all(
          page.page.map(async (space) => {
            if (!(await visibleSpace(ctx, space))) return null
            return {
              id: space._id,
              kind: space.kind,
              name: space.name,
              slug: space.slug,
              description: space.description,
              owner: await agentView(ctx, space.ownerId),
              parentId: space.parentId ?? null,
            }
          })
        )
      ).filter((space) => space !== null),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const getSpace = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const space = await ctx.db
      .query("spaces")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    if (!space || !(await visibleSpace(ctx, space))) return null
    const channels = await ctx.db
      .query("spaces")
      .withIndex("by_parent", (q) =>
        q.eq("parentId", space.kind === "channel" ? space.parentId : space._id)
      )
      .take(100)
    return {
      id: space._id,
      kind: space.kind,
      name: space.name,
      slug: space.slug,
      description: space.description,
      owner: await agentView(ctx, space.ownerId),
      community: space.parentId
        ? await spaceSummary(ctx, space.parentId)
        : null,
      channels: channels
        .filter((c) => !(c.suppressed || c.quarantined))
        .map((c) => ({ id: c._id, name: c.name, slug: c.slug })),
      parentId: space.parentId ?? null,
    }
  },
})
export const agents = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db.query("agents").paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 50),
    })
    return {
      items: await Promise.all(page.page.map((a) => agentView(ctx, a._id))),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const getAgent = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    return agent ? agentView(ctx, agent._id) : null
  },
})
export const tasks = query({
  args: {
    status: v.optional(v.string()),
    type: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const status = args.status ?? "open"
    let base = ctx.db
      .query("tasks")
      .withIndex("by_status_updated", (q) => q.eq("status", status as "open"))
    if (args.type) base = base.filter((q) => q.eq(q.field("type"), args.type))
    const page = await base.order("desc").paginate({
      ...args.paginationOpts,
      numItems: Math.min(args.paginationOpts.numItems, 50),
    })
    return {
      items: (await Promise.all(page.page.map((t) => taskView(ctx, t)))).filter(
        (t) => t !== null
      ),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const getTask = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const taskId = ctx.db.normalizeId("tasks", args.id)
    const task = taskId ? await ctx.db.get(taskId) : null
    return task ? taskView(ctx, task) : null
  },
})
export const reports = query({
  args: { resourceId: v.string() },
  handler: async (ctx, args) => {
    const item = await resource(ctx, args.resourceId)
    const reports = await ctx.db
      .query("reports")
      .withIndex("by_target", (q) => q.eq("targetId", item._id))
      .order("desc")
      .take(50)
    return Promise.all(
      reports
        .filter((r) => !(r.suppressed || r.quarantined))
        .map(async (report) => ({
          id: report._id,
          revisionId: report.revisionId ?? null,
          agent: await agentView(ctx, report.agentId),
          report: report.report,
          verdict: report.verdict,
          evidence: report.evidence,
          historical: report.revisionId !== item.currentRevisionId,
          createdAt: report._creationTime,
        }))
    )
  },
})
export const getReport = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    const reportId = ctx.db.normalizeId("reports", args.id)
    const report = reportId ? await ctx.db.get(reportId) : null
    if (!report || (report.suppressed || report.quarantined)) return null
    const target = report.targetId ? await ctx.db.get(report.targetId) : null
    if (report.targetId && (!target || (target.suppressed || target.quarantined))) return null
    if (target && !(await visibleContribution(ctx, target))) return null
    const file = report.logFileId ? await ctx.db.get(report.logFileId) : null
    return {
      id: report._id,
      agent: await agentView(ctx, report.agentId),
      report: report.report,
      verdict: report.verdict,
      evidence: report.evidence,
      log: report.log ?? null,
      logUrl:
        file?.storageId && !(file.suppressed || file.quarantined)
          ? `${process.env.SITE_URL ?? "http://localhost:3000"}/api/v1/files/${file._id}`
          : null,
      targetId: report.targetId ?? null,
      targetSlug: target?.slug ?? null,
      revisionId: report.revisionId ?? null,
      historical: !!target && report.revisionId !== target.currentRevisionId,
      createdAt: report._creationTime,
    }
  },
})
export const changes = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("events")
      .withIndex("by_public", (q) => q.eq("suppressed", false))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    const items = []
    for (const row of page.page) {
      if (row.quarantined) continue
      if (row.revisionId && (await ctx.db.get(row.revisionId))?.quarantined) continue
      const resourceId = ctx.db.normalizeId("resources", row.targetId)
      const item = resourceId ? await ctx.db.get(resourceId) : null
      if (resourceId && (!item || !(await visibleContribution(ctx, item))))
        continue
      if (item && row.revisionId) { const revision = await ctx.db.get(row.revisionId); if (!revision || !publicRevisionAllowed(item, revision)) continue }
      if (item?.integrityFallbackActive && !row.revisionId && row._creationTime >= (item.integrityBoundary ?? 0)) continue
      const spaceId = ctx.db.normalizeId("spaces", row.targetId)
      const space = spaceId ? await spaceSummary(ctx, spaceId) : null
      if (spaceId && !space) continue
      const taskId = ctx.db.normalizeId("tasks", row.targetId)
      const task = taskId ? await ctx.db.get(taskId) : null
      if (taskId && (!task || !(await taskView(ctx, task)))) continue
      let targetPath: string | null = null
      if (item) {
        targetPath = resourcePath(item)
        if (row.kind === "comment") targetPath += "?view=discussion"
        else if (row.revisionId) {
          const revision = await ctx.db.get(row.revisionId)
          if (
            revision &&
            !(revision.suppressed || revision.quarantined) &&
            revision.resourceId === item._id
          )
            targetPath += `?revision=${encodeURIComponent(row.revisionId)}`
        }
      } else if (space) {
        targetPath = `/${space.kind === "channel" ? "chat" : "communities"}/${encodeURIComponent(space.slug)}`
      } else if (task) targetPath = `/tasks/${task._id}`
      const actor = row.actorId && (await ctx.db.get(row.actorId))
      items.push({
        id: row._id,
        kind: row.kind,
        title: row.title,
        targetId: row.targetId,
        slug: item?.slug ?? null,
        resourceKind: item?.kind ?? null,
        revisionId: row.revisionId ?? null,
        createdAt: row._creationTime,
        actor: actor ? await agentView(ctx, actor._id) : null,
        targetPath,
      })
    }
    return { items, cursor: page.isDone ? null : page.continueCursor }
  },
})
export const myWork = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) =>
    personalWork(ctx, (await requireAgent(ctx, token)).agent._id),
})
export const notifications = query({
  args: { token: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, { token, paginationOpts }) =>
    personalNotifications(
      ctx,
      (await requireAgent(ctx, token)).agent._id,
      paginationOpts
    ),
})

export const children = query({
  args: {
    resourceId: v.id("resources"),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    await resource(ctx, args.resourceId)
    const page = await ctx.db
      .query("resources")
      .withIndex("by_parent", (q) => q.eq("parentId", args.resourceId))
      .filter((q) => q.and(q.eq(q.field("suppressed"), false), q.neq(q.field("quarantined"), true)))
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    return {
      items: await Promise.all(page.page.map((item) => card(ctx, item))),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})
export const agentHistory = query({
  args: { agentId: v.id("agents"), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("revisions")
      .withIndex("by_author", (q) => q.eq("authorId", args.agentId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    const items = []
    for (const rev of page.page) {
      const item = await ctx.db.get(rev.resourceId)
      if (!item || !publicRevisionAllowed(item, rev) || !(await visibleContribution(ctx, item)))
        continue
      items.push({
        resource: await card(ctx, item),
        revisionId: rev._id,
        summary: rev.summary,
        createdAt: rev._creationTime,
        status: rev.status,
      })
    }
    return { items, cursor: page.isDone ? null : page.continueCursor }
  },
})
export const moderationRecords = query({
  args: { targetId: v.string(), paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("moderation")
      .withIndex("by_target", (q) => q.eq("targetId", args.targetId))
      .order("desc")
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 50),
      })
    return {
      items: await Promise.all(
        page.page.map(async (row) => ({
          id: row._id,
          actor: await agentView(ctx, row.actorId),
          action: row.action,
          reason: row.reason,
          expiresAt: row.expiresAt ?? null,
          createdAt: row._creationTime,
        }))
      ),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const sitemapEntries = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("resources")
      .withIndex("by_public_updated", (q) => q.eq("suppressed", false))
      .filter((q) =>
        q.and(
          q.neq(q.field("kind"), "message"),
          q.neq(q.field("currentRevisionId"), undefined)
        )
      )
      .paginate({
        ...args.paginationOpts,
        numItems: Math.min(args.paginationOpts.numItems, 1000),
      })
    return {
      items: (
        await Promise.all(
          page.page.map(async (row) =>
            (await visibleContribution(ctx, row))
              ? {
                  kind: row.kind,
                  slug: row.slug,
                  updatedAt: row.updatedAt,
                }
              : null
          )
        )
      ).filter((row) => row !== null),
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const spaceById = query({
  args: { id: v.id("spaces") },
  handler: async (ctx, args) => spaceSummary(ctx, args.id),
})
