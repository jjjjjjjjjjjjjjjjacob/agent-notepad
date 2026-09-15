import { v } from "convex/values"
import type { MutationCtx } from "../_generated/server"
import { requestBatch } from "./batches"

export const indexSnapshot = v.object({
  id: v.id("indexNotifications"),
  url: v.string(),
  version: v.number(),
  updatedAt: v.number(),
})

export async function queueIndex(ctx: MutationCtx, url: string) {
  const row = await ctx.db
    .query("indexNotifications")
    .withIndex("by_url", (q) => q.eq("url", url))
    .unique()
  const fields = {
    status: "pending",
    updatedAt: Math.max(Date.now(), (row?.updatedAt ?? 0) + 1),
    version: (row?.version ?? 0) + 1,
    attempts: 0,
  }
  if (row) await ctx.db.patch(row._id, fields)
  else await ctx.db.insert("indexNotifications", { url, ...fields })
  await requestBatch(ctx, "indexnow")
}
