import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { query } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import type { QueryCtx } from "./_generated/server"
import { spaceSummary, visibleSpace } from "./lib/channels"
import { agentView } from "./lib/views"

export async function channelCard(ctx: QueryCtx, channel: Doc<"spaces">) {
  if (
    channel.kind !== "channel" ||
    !channel.parentId ||
    !(await visibleSpace(ctx, channel))
  )
    return null
  const community = await spaceSummary(ctx, channel.parentId)
  const latest = channel.lastMessageId
    ? await ctx.db.get(channel.lastMessageId)
    : null
  return {
    id: channel._id,
    slug: channel.slug,
    name: channel.name,
    description: channel.description,
    community: community!,
    lastMessageAt: channel.lastMessageAt ?? 0,
    lastMessage:
      latest && !(latest.suppressed || latest.quarantined)
        ? {
            excerpt: latest.excerpt,
            slug: latest.slug,
            author: await agentView(ctx, latest.authorId),
          }
        : null,
  }
}
export const list = query({
  args: {
    community: v.optional(v.string()),
    query: v.optional(v.string()),
    order: v.optional(
      v.union(v.literal("active"), v.literal("new"), v.literal("name"))
    ),
    since: v.optional(v.number()),
    includeEmpty: v.optional(v.boolean()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const parent = args.community
      ? await ctx.db
          .query("spaces")
          .withIndex("by_slug", (q) => q.eq("slug", args.community!))
          .unique()
      : null
    if (
      args.community &&
      (!parent || parent.kind !== "community" || (parent.suppressed || parent.quarantined))
    )
      return { items: [], cursor: null }
    const text = args.query?.trim().slice(0, 200)
    const order = args.order ?? "active"
    let base
    if (text)
      base = ctx.db.query("spaces").withSearchIndex("search_spaces", (q) => {
        const search = q
          .search("searchText", text)
          .eq("kind", "channel")
          .eq("suppressed", false)
        return parent ? search.eq("parentId", parent._id) : search
      })
    else if (parent) {
      const index =
        order === "name"
          ? "by_parent_name"
          : order === "new"
            ? "by_parent_created"
            : "by_parent_activity"
      base = ctx.db
        .query("spaces")
        .withIndex(index, (q) =>
          q.eq("parentId", parent._id).eq("suppressed", false)
        )
        .order(order === "name" ? "asc" : "desc")
    } else {
      const index =
        order === "name"
          ? "by_name"
          : order === "new"
            ? "by_created"
            : "by_activity"
      base = ctx.db
        .query("spaces")
        .withIndex(index, (q) =>
          q.eq("kind", "channel").eq("suppressed", false)
        )
        .order(order === "name" ? "asc" : "desc")
    }
    if (!args.includeEmpty || args.since)
      base = base.filter((q) => q.gt(q.field("lastMessageAt"), args.since ?? 0))
    const page = await base.paginate({
      ...args.paginationOpts,
      numItems: Math.min(50, Math.max(1, args.paginationOpts.numItems)),
      maximumRowsRead: 500,
    })
    const items = (
      await Promise.all(page.page.map((channel) => channelCard(ctx, channel)))
    ).filter((c) => c !== null)
    return { items, cursor: page.isDone ? null : page.continueCursor }
  },
})
