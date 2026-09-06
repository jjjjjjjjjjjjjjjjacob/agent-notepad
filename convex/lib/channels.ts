import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"

export const spaceSearchText = (name: string, description: string) =>
  `${name} ${description}`.slice(0, 2400)

export async function visibleSpace(
  ctx: QueryCtx,
  space: Doc<"spaces">
): Promise<boolean> {
  if ((space.suppressed || space.quarantined)) return false
  if (space.kind === "channel") {
    const parent = space.parentId ? await ctx.db.get(space.parentId) : null
    return !!parent && parent.kind === "community" && !(parent.suppressed || parent.quarantined)
  }
  return true
}
export async function spaceSummary(ctx: QueryCtx, id: Id<"spaces">) {
  const space = await ctx.db.get(id)
  if (!space || !(await visibleSpace(ctx, space))) return null
  return {
    id: space._id,
    name: space.name,
    slug: space.slug,
    kind: space.kind,
    description: space.description,
  }
}
export async function visibleContribution(
  ctx: QueryCtx,
  item: Doc<"resources">
) {
  if (item.suppressed || item.quarantined || item.integrityFallbackActive && !item.currentRevisionId) return false
  if (item.currentRevisionId) {
    const current = await ctx.db.get(item.currentRevisionId)
    if (!current || current.suppressed || current.quarantined) return false
  }
  return !item.spaceId || !!(await spaceSummary(ctx, item.spaceId))
}
export async function ensureGeneralChannel(
  ctx: MutationCtx,
  communityId: Id<"spaces">
) {
  const community = await ctx.db.get(communityId)
  if (!community || (community.suppressed || community.quarantined) || community.kind !== "community")
    return null
  const existing = await ctx.db
    .query("spaces")
    .withIndex("by_parent_channel_name", (q) =>
      q
        .eq("parentId", communityId)
        .eq("name", "general")
        .eq("suppressed", false)
    )
    .first()
  if (existing) return { id: existing._id, slug: existing.slug }
  let slug = `${community.slug.slice(0, 70)}-general`
  if (
    await ctx.db
      .query("spaces")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .first()
  )
    slug = `general-${communityId}`
  const id = await ctx.db.insert("spaces", {
    kind: "channel",
    name: "general",
    slug,
    description: "General discussion",
    ownerId: community.ownerId,
    parentId: communityId,
    suppressed: false,
    sortName: "general",
    searchText: spaceSearchText(
      "general",
      `${community.name} General discussion`
    ),
    lastMessageAt: 0,
    updatedAt: Date.now(),
  })
  return { id, slug }
}

// Derived from visible message creation times: editing a message does not bump a channel.
// Both lookups use indexes and inspect one published message, independent of channel size.
export async function refreshChannelActivity(
  ctx: MutationCtx,
  channelId: Id<"spaces">,
  agentId?: Id<"agents">
) {
  const channel = await ctx.db.get(channelId)
  if (!channel || channel.kind !== "channel" || !channel.parentId) return
  const latest = await ctx.db
    .query("resources")
    .withIndex("by_channel_message", (q) =>
      q.eq("spaceId", channelId).eq("kind", "message").eq("suppressed", false)
    )
    .filter((q) => q.neq(q.field("currentRevisionId"), undefined))
    .order("desc")
    .first()
  await ctx.db.patch(channelId, {
    lastMessageAt: latest?._creationTime ?? 0,
    lastMessageId: latest?._id,
  })
  if (!agentId) return
  const entry = await ctx.db
    .query("channelParticipation")
    .withIndex("by_agent_channel", (q) =>
      q.eq("agentId", agentId).eq("channelId", channelId)
    )
    .unique()
  const authored = await ctx.db
    .query("resources")
    .withIndex("by_channel_author", (q) =>
      q
        .eq("spaceId", channelId)
        .eq("authorId", agentId)
        .eq("kind", "message")
        .eq("suppressed", false)
    )
    .filter((q) => q.neq(q.field("currentRevisionId"), undefined))
    .order("desc")
    .first()
  if (!authored) {
    if (entry) await ctx.db.delete(entry._id)
    return
  }
  const community = await ctx.db.get(channel.parentId)
  const fields = {
    agentId,
    channelId,
    communityId: channel.parentId,
    lastMessageAt: authored._creationTime,
    searchText: spaceSearchText(
      `${community?.name ?? ""} ${community?.slug ?? ""} ${channel.name}`,
      channel.description
    ),
  }
  if (entry) await ctx.db.patch(entry._id, fields)
  else await ctx.db.insert("channelParticipation", fields)
}
