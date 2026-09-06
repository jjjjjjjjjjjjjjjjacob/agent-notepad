import { paginationOptsValidator } from "convex/server"
import { v } from "convex/values"
import { query } from "./_generated/server"
import { authComponent } from "./auth"
import { fail } from "./lib/core"
import { spaceSummary } from "./lib/channels"
import { channelCard } from "./channels"
import { agentView } from "./lib/views"

export const inspect = query({
  args: {
    slug: v.string(),
    view: v.union(
      v.literal("participating"),
      v.literal("owned"),
      v.literal("moderating")
    ),
    query: v.optional(v.string()),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    if (!user || !agent || agent.ownerId !== user._id)
      fail("FORBIDDEN", "You can inspect only agents linked to your account.")
    const opts = {
      ...args.paginationOpts,
      numItems: Math.min(25, args.paginationOpts.numItems),
      maximumRowsRead: 500,
    }
    const term = args.query?.trim().slice(0, 200)
    if (args.view === "participating") {
      const base = term
        ? ctx.db
            .query("channelParticipation")
            .withSearchIndex("search_participation", (q) =>
              q.search("searchText", term).eq("agentId", agent._id)
            )
        : ctx.db
            .query("channelParticipation")
            .withIndex("by_agent_activity", (q) => q.eq("agentId", agent._id))
            .order("desc")
      const page = await base.paginate(opts)
      const channels = (
        await Promise.all(
          page.page.map(async (row) => {
            const channel = await ctx.db.get(row.channelId)
            return channel ? channelCard(ctx, channel) : null
          })
        )
      ).filter((c) => c !== null)
      return {
        agent: await agentView(ctx, agent._id),
        channels,
        communities: [],
        cursor: page.isDone ? null : page.continueCursor,
      }
    }
    if (args.view === "owned") {
      const base = term
        ? ctx.db
            .query("spaces")
            .withSearchIndex("search_spaces", (q) =>
              q
                .search("searchText", term)
                .eq("kind", "community")
                .eq("suppressed", false)
                .eq("ownerId", agent._id)
            )
        : ctx.db
            .query("spaces")
            .withIndex("by_owner_kind", (q) =>
              q.eq("ownerId", agent._id).eq("kind", "community")
            )
            .filter((q) => q.eq(q.field("suppressed"), false))
            .order("desc")
      const page = await base.paginate(opts)
      const communities = (
        await Promise.all(
          page.page.map((space) => spaceSummary(ctx, space._id))
        )
      ).filter((c) => c !== null)
      return {
        agent: await agentView(ctx, agent._id),
        channels: [],
        communities,
        cursor: page.isDone ? null : page.continueCursor,
      }
    }
    const base = term
      ? ctx.db
          .query("memberships")
          .withSearchIndex("search_memberships", (q) =>
            q.search("searchText", term).eq("agentId", agent._id)
          )
      : ctx.db
          .query("memberships")
          .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
          .order("desc")
    const page = await base.paginate(opts)
    const communities = (
      await Promise.all(
        page.page.map(async (row) => {
          const space = await ctx.db.get(row.spaceId)
          return space ? spaceSummary(ctx, space.parentId ?? space._id) : null
        })
      )
    ).filter((c) => c !== null)
    return {
      agent: await agentView(ctx, agent._id),
      channels: [],
      communities: [...new Map(communities.map((c) => [c.id, c])).values()],
      cursor: page.isDone ? null : page.continueCursor,
    }
  },
})

export const canInspect = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const user = await authComponent.safeGetAuthUser(ctx)
    if (!user) return false
    const agent = await ctx.db
      .query("agents")
      .withIndex("by_slug", (q) => q.eq("slug", args.slug))
      .unique()
    return !!agent && agent.ownerId === user._id
  },
})
