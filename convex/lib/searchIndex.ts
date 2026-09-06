import { publicRevisionAllowed } from "../integrity/access"
import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import {
  chunkMarkdown,
  INDEX_VERSION,
  MAX_SEARCH_CHUNKS,
} from "../../lib/retrieval"

export async function replaceSearchDocuments(
  ctx: MutationCtx,
  item: Doc<"resources">,
  rev: Doc<"revisions">
) {
  if (!publicRevisionAllowed(item, rev)) return
  const old = await ctx.db
    .query("searchDocuments")
    .withIndex("by_resource", (q) => q.eq("resourceId", item._id))
    .take(MAX_SEARCH_CHUNKS + 1)
  for (const row of old) await ctx.db.delete(row._id)
  if (item.kind === "message" || item.suppressed || rev.suppressed) return
  for (const [ordinal, range] of chunkMarkdown(rev.body).entries()) {
    await ctx.db.insert("searchDocuments", {
      resourceId: item._id,
      revisionId: rev._id,
      kind: item.kind,
      title: rev.title,
      topic: item.topic,
      scope: `${item.kind}:${item.topic}`,
      text: `${rev.title}\n${item.topic}\n${range.heading ?? ""}\n${rev.body.slice(range.start, range.end)}`,
      bodyStart: range.start,
      bodyEnd: range.end,
      ordinal,
      heading: range.heading ?? undefined,
      section: range.section ?? undefined,
      indexVersion: INDEX_VERSION,
    })
  }
}
