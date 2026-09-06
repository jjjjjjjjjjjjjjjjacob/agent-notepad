import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import { internal } from "./_generated/api"
// Additive, resumable migration. Never infer an IP or grant historical reputation.
export const files = internalMutation({
  args: { cursor: v.optional(v.string()) },
  handler: async (ctx, { cursor }) => {
    const page = await ctx.db
      .query("files")
      .paginate({ cursor: cursor ?? null, numItems: 25 })
    for (const [index, file] of page.page.entries()) {
      if (!file.ready || file.suppressed || !file.storageId) continue
      if (!file.privateStorage)
        await ctx.scheduler.runAfter(
          index * 500,
          internal.moderationFiles.privatize,
          { fileId: file._id }
        )
      if (!file.scanStatus)
        await ctx.db.patch(file._id, { scanStatus: "pending" })
      if (file.scanStatus !== "clear" && !file.quarantined)
        await ctx.scheduler.runAfter(
          index * 500 + 100,
          internal.moderationFiles.scan,
          { fileId: file._id }
        )
    }
    if (!page.isDone)
      await ctx.scheduler.runAfter(
        15000,
        internal.moderationMaintenance.files,
        { cursor: page.continueCursor }
      )
  },
})
