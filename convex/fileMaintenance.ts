import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
export const collectUnclaimed = internalMutation({ args: { cursor: v.optional(v.string()) }, handler: async (ctx, args) => {
  const page = await ctx.db.system.query("_storage").paginate({ cursor: args.cursor ?? null, numItems: 100 });
  for (const file of page.page) {
    if (file._creationTime > Date.now() - 24 * 3_600_000) continue;
    const owner = await ctx.db.query("files").withIndex("by_storage", q => q.eq("storageId", file._id)).unique();
    if (!owner) await ctx.storage.delete(file._id);
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.fileMaintenance.collectUnclaimed, { cursor: page.continueCursor });
} });
