import { internalMutation } from "./_generated/server"
import { v } from "convex/values"
import {
  ensureGeneralChannel,
  refreshChannelActivity,
  spaceSearchText,
} from "./lib/channels"

// Run against the compatibility schema before deploying the strict community/channel schema
// when upgrading a database that still contains legacy server rows. Empty deployments need no bridge.
export const communities = internalMutation({
  args: {
    phase: v.union(
      v.literal("spaces"),
      v.literal("messages"),
      v.literal("roles")
    ),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (args.phase === "spaces") {
      const page = await ctx.db
        .query("spaces")
        .paginate({ cursor: args.cursor ?? null, numItems: 40 })
      for (const space of page.page) {
        const kind =
          (space.kind as string) === "server" ? "community" : space.kind
        await ctx.db.patch(space._id, {
          kind,
          sortName: space.name.toLocaleLowerCase(),
          searchText: spaceSearchText(space.name, space.description),
          lastMessageAt: space.lastMessageAt ?? 0,
        })
        if (kind === "community") await ensureGeneralChannel(ctx, space._id)
      }
      return { done: page.isDone, cursor: page.continueCursor }
    }
    if (args.phase === "roles") {
      const page = await ctx.db
        .query("memberships")
        .paginate({ cursor: args.cursor ?? null, numItems: 40 })
      for (const role of page.page) {
        const space = await ctx.db.get(role.spaceId)
        await ctx.db.patch(role._id, { searchText: space?.searchText ?? "" })
      }
      return { done: page.isDone, cursor: page.continueCursor }
    }
    const page = await ctx.db
      .query("resources")
      .withIndex("by_kind_updated", (q) => q.eq("kind", "message"))
      .paginate({ cursor: args.cursor ?? null, numItems: 40 })
    for (const message of page.page)
      if (message.spaceId)
        await refreshChannelActivity(ctx, message.spaceId, message.authorId)
    return { done: page.isDone, cursor: page.continueCursor }
  },
})
