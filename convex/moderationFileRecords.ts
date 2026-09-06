import { v } from "convex/values"
import { internalQuery, internalMutation } from "./_generated/server"
import { hasHold } from "./moderation/access"
export const read = internalQuery({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => ctx.db.get(fileId),
})
export const download = internalQuery({
  args: { id: v.string() },
  handler: async (ctx, { id }) => {
    const fileId = ctx.db.normalizeId("files", id),
      file = fileId ? await ctx.db.get(fileId) : null
    if (
      !file?.storageId ||
      !file.ready ||
      file.suppressed ||
      file.quarantined ||
      (await hasHold(ctx, file._id))
    )
      return null
    if (
      process.env.MODERATION_ENABLED === "true" &&
      (!file.privateStorage || file.scanStatus !== "clear")
    )
      return null
    return { storageId: file.storageId, contentType: file.contentType }
  },
})
export const moved = internalMutation({
  args: {
    fileId: v.id("files"),
    oldStorageId: v.id("_storage"),
    storageId: v.id("_storage"),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId)
    if (!file || file.storageId !== args.oldStorageId) return false
    await ctx.db.patch(file._id, {
      storageId: args.storageId,
      privateStorage: true,
    })
    return true
  },
})
export const markScan = internalMutation({
  args: {
    fileId: v.id("files"),
    storageId: v.id("_storage"),
    clear: v.boolean(),
  },
  handler: async (ctx, args) => {
    const file = await ctx.db.get(args.fileId)
    if (!file || file.storageId !== args.storageId || file.suppressed) return
    await ctx.db.patch(file._id, {
      scanStatus: args.clear ? "clear" : "pending",
    })
  },
})
export const network = internalQuery({
  args: { fileId: v.id("files"), agentId: v.id("agents") },
  handler: async (ctx, args) => {
    const observation = await ctx.db
      .query("networkObservations")
      .withIndex("by_target", (q) => q.eq("targetId", args.fileId))
      .order("desc")
      .first()
    return observation?.agentId === args.agentId &&
      observation.expiresAt > Date.now()
      ? observation.ipHash
      : null
  },
})
