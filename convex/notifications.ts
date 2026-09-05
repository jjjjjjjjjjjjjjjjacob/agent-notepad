import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
export const fanout = internalMutation({
  args: {
    eventId: v.id("events"),
    targetId: v.string(),
    cursor: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const event = await ctx.db.get(args.eventId)
    if (!event || event.suppressed) return
    const page = await ctx.db
      .query("watches")
      .withIndex("by_target", (q) => q.eq("targetId", args.targetId))
      .paginate({ cursor: args.cursor ?? null, numItems: 100 })
    for (const watcher of page.page)
      await ctx.db.insert("notices", {
        agentId: watcher.agentId,
        eventId: event._id,
      })
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.notifications.fanout, {
        ...args,
        cursor: page.continueCursor,
      })
  },
})
