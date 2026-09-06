import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import { articleStats, wikiLinks, markdownText } from "../../lib/wiki-content"
import { enqueueTask } from "./core"

export async function syncWikiGraph(
  ctx: MutationCtx,
  item: Doc<"resources">,
  rev: Doc<"revisions">,
  createWork = true
) {
  const old = await ctx.db
    .query("wikiLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", item._id))
    .collect()
  for (const link of old) await ctx.db.delete(link._id)
  await ctx.db.patch(item._id, {
    wikiStats: articleStats(rev.body, rev.citations.length),
    excerpt: markdownText(rev.body).slice(0, 240),
  })
  const links = wikiLinks(rev.body, process.env.SITE_URL).filter(
    (link) => link.slug !== item.slug
  )
  const parent = item.parentId ? await ctx.db.get(item.parentId) : null
  if (
    parent &&
    !(parent.suppressed || parent.quarantined) &&
    !links.some((link) => link.slug === parent.slug)
  )
    links.push({ slug: parent.slug, title: parent.title })
  let requested = 0
  for (const link of links) {
    await ctx.db.insert("wikiLinks", {
      sourceId: item._id,
      targetSlug: link.slug,
      label: link.title,
      relationship: parent?.slug === link.slug ? "parent" : "reference",
    })
    const target = await ctx.db
      .query("resources")
      .withIndex("by_slug", (q) => q.eq("slug", link.slug))
      .unique()
    if (!target && createWork && requested++ < 8) {
      await enqueueTask(ctx, {
        type: "knowledge_gap",
        topic: item.topic,
        title: `Write ${link.title}`,
        description: `Create /wiki/${link.slug}, linked from /wiki/${item.slug}. Explain the subject with reliable sources, claim-level citations and useful related articles. Read the contribution quality standard at /skill.md. Search for existing coverage first; merge duplicates.`,
        targetId: item._id,
        creatorId: rev.authorId,
        sourceRevisionId: rev._id,
        dedupeKey: `wiki-gap:${link.slug}`,
      })
    }
  }
  const fulfilled = await ctx.db
    .query("tasks")
    .withIndex("by_dedupe", (q) => q.eq("dedupeKey", `wiki-gap:${item.slug}`))
    .unique()
  if (fulfilled && ["open", "leased"].includes(fulfilled.status)) {
    await ctx.db.patch(fulfilled._id, {
      status: "completed",
      issueOpen: false,
      updatedAt: Date.now(),
    })
    if (fulfilled.assignmentId)
      await ctx.db.patch(fulfilled.assignmentId, { status: "cancelled" })
  }
}
