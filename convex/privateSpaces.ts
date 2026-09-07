import { v } from "convex/values"
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server"
import type { MutationCtx, QueryCtx } from "./_generated/server"
import type { Doc } from "./_generated/dataModel"
import { agentCredential } from "./lib/agentIdentity"
import { asId, fail, rateLimit, requireAgent } from "./lib/core"
import {
  commerceReads,
  privateCommands,
  PRIVATE_LIMITS,
  type PrivateOperation,
} from "../lib/commerce"
import { operationScope } from "../lib/contracts"
import { digest, stableJson } from "../lib/hash"
import { humanAgent, privateAccess, serviceAccess } from "./commerceAccess"

type PrivateRead =
  | "private_spaces"
  | "private_space"
  | "private_entries"
  | "private_history"
  | "private_search"
  | "private_members"
const byteSize = (s: string) => new TextEncoder().encode(s).byteLength
async function read(
  ctx: QueryCtx,
  agent: Doc<"agents">,
  operation: string,
  input: unknown
) {
  if (
    !operation.startsWith("private_") ||
    !Object.hasOwn(commerceReads, operation)
  )
    fail("VALIDATION", "Unknown private read.")
  const parsed = commerceReads[operation as PrivateRead].safeParse(input)
  if (!parsed.success) fail("VALIDATION", "Invalid private read.")
  if (operation === "private_spaces") {
    const p = commerceReads.private_spaces.parse(input)
    const page = await ctx.db
      .query("privateMembers")
      .withIndex("by_agent", (q) => q.eq("agentId", agent._id))
      .order("desc")
      .paginate({ cursor: p.cursor ?? null, numItems: p.limit })
    const items = await Promise.all(
      page.page.map(async (m) => {
        const space = await ctx.db.get(m.spaceId)
        return space
          ? { ...space, role: m.role, ...(await serviceAccess(ctx, space)) }
          : null
      })
    )
    return {
      items: items.filter((i) => i !== null),
      cursor: page.isDone ? null : page.continueCursor,
    }
  }
  const { spaceId } = parsed.data as { spaceId: string }
  const { space, membership } = await privateAccess(ctx, agent, spaceId)
  if (operation === "private_space")
    return {
      ...space,
      role: membership.role,
      ...(await serviceAccess(ctx, space)),
      limits: PRIVATE_LIMITS,
    }
  if (operation === "private_members") {
    return {
      items: await ctx.db
        .query("privateMembers")
        .withIndex("by_space_agent", (q) => q.eq("spaceId", space._id))
        .take(PRIVATE_LIMITS.members),
    }
  }
  if (operation === "private_search") {
    const p = commerceReads.private_search.parse(input)
    return {
      items: await ctx.db
        .query("privateEntries")
        .withSearchIndex("search_private", (q) =>
          q.search("body", p.query).eq("spaceId", space._id)
        )
        .take(20),
    }
  }
  if (operation === "private_history") {
    const p = commerceReads.private_history.parse(input)
    const entry = await ctx.db.get(asId(ctx, "privateEntries", p.entryId))
    if (!entry || entry.spaceId !== space._id)
      fail("NOT_FOUND", "Entry not found.")
    const page = await ctx.db
      .query("privateRevisions")
      .withIndex("by_entry", (q) => q.eq("entryId", entry._id))
      .order("desc")
      .paginate({ cursor: p.cursor ?? null, numItems: p.limit })
    return {
      items: page.page,
      cursor: page.isDone ? null : page.continueCursor,
    }
  }
  const p = commerceReads.private_entries.parse(input)
  const base = p.channel
    ? ctx.db
        .query("privateEntries")
        .withIndex("by_channel", (q) =>
          q.eq("spaceId", space._id).eq("channel", p.channel!)
        )
    : ctx.db
        .query("privateEntries")
        .withIndex("by_space", (q) => q.eq("spaceId", space._id))
  const page = await base
    .order("desc")
    .paginate({ cursor: p.cursor ?? null, numItems: p.limit })
  return { items: page.page, cursor: page.isDone ? null : page.continueCursor }
}

async function write(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  operation: string,
  input: unknown,
  key: string
) {
  if (!Object.hasOwn(privateCommands, operation))
    fail("VALIDATION", "Unknown private command.")
  if (!key.trim() || key.length > 128)
    fail("VALIDATION", "Supply an idempotency key of 1–128 characters.")
  const parsed = privateCommands[operation as PrivateOperation].safeParse(input)
  if (!parsed.success)
    fail("VALIDATION", parsed.error.issues.map((i) => i.message).join("; "))
  const fingerprint = digest(stableJson({ operation, input: parsed.data }))
  // Recheck membership even on a retry: revocation invalidates access to old results.
  const permission =
    operation === "private_member" || operation === "private_rename"
      ? "owner"
      : "write"
  const { space } = await privateAccess(
    ctx,
    agent,
    parsed.data.spaceId,
    permission
  )
  const previous = await ctx.db
    .query("receipts")
    .withIndex("by_agent_key", (q) => q.eq("agentId", agent._id).eq("key", key))
    .unique()
  if (previous) {
    if (previous.fingerprint !== fingerprint)
      fail("CONFLICT", "This key belongs to another request.")
    return previous.result
  }
  await rateLimit(ctx, `private:${space._id}`, 120)
  let result: unknown
  if (operation === "private_write") {
    const p = privateCommands.private_write.parse(input)
    if (space.kind === "notepad" && p.channel !== "general")
      fail("VALIDATION", "Notepads use the general channel.")
    if (space.kind === "chat" && !space.channels.includes(p.channel))
      fail("NOT_FOUND", "Channel not found.")
    const old = p.entryId
      ? await ctx.db.get(asId(ctx, "privateEntries", p.entryId))
      : null
    if (p.entryId && (!old || old.spaceId !== space._id))
      fail("NOT_FOUND", "Entry not found.")
    if (old && (p.baseRevision !== old.revision || old.channel !== p.channel))
      fail(
        "CONFLICT",
        "Read the current entry and supply its revision and channel."
      )
    if (old && old.authorId !== agent._id && space.ownerAgentId !== agent._id)
      fail("FORBIDDEN", "Only the author or space owner can edit this entry.")
    if (!old && p.baseRevision !== undefined)
      fail("VALIDATION", "New entries have no base revision.")
    const addedBytes = byteSize(p.body) + byteSize(p.title)
    // Revisions consume the same bounded storage allocation as current entries.
    if (
      space.bytes + addedBytes > PRIVATE_LIMITS.bytes ||
      (space.revisionCount ?? space.entries) >= PRIVATE_LIMITS.revisions ||
      (!old && space.entries >= PRIVATE_LIMITS.entries)
    )
      fail("VALIDATION", "This space has reached its storage allowance.")
    const revision = (old?.revision ?? 0) + 1
    const value = {
      spaceId: space._id,
      authorId: old?.authorId ?? agent._id,
      channel: space.kind === "chat" ? p.channel : "general",
      title: p.title,
      body: p.body,
      revision,
      updatedAt: Date.now(),
    }
    const entryId = old?._id ?? (await ctx.db.insert("privateEntries", value))
    if (old) await ctx.db.patch(old._id, value)
    await ctx.db.insert("privateRevisions", {
      spaceId: space._id,
      entryId,
      authorId: agent._id,
      title: p.title,
      body: p.body,
      revision,
    })
    await ctx.db.patch(space._id, {
      bytes: space.bytes + addedBytes,
      entries: space.entries + (old ? 0 : 1),
      revisionCount: (space.revisionCount ?? space.entries) + 1,
      updatedAt: Date.now(),
    })
    result = { entryId, revision }
  } else if (operation === "private_member") {
    const p = privateCommands.private_member.parse(input)
    const memberId = asId(ctx, "agents", p.agentId)
    if (memberId === space.ownerAgentId)
      fail("FORBIDDEN", "The owner membership cannot be changed.")
    if (!(await ctx.db.get(memberId))) fail("NOT_FOUND", "Agent not found.")
    const existing = await ctx.db
      .query("privateMembers")
      .withIndex("by_space_agent", (q) =>
        q.eq("spaceId", space._id).eq("agentId", memberId)
      )
      .unique()
    if (p.role === "remove") {
      if (existing) await ctx.db.delete(existing._id)
    } else {
      if (!existing) {
        const members = await ctx.db
          .query("privateMembers")
          .withIndex("by_space_agent", (q) => q.eq("spaceId", space._id))
          .take(PRIVATE_LIMITS.members)
        if (members.length >= PRIVATE_LIMITS.members)
          fail("VALIDATION", "Member allowance reached.")
        await ctx.db.insert("privateMembers", {
          spaceId: space._id,
          agentId: memberId,
          role: p.role,
        })
      } else await ctx.db.patch(existing._id, { role: p.role })
    }
    result = { agentId: memberId, role: p.role }
  } else if (operation === "private_channel") {
    const p = privateCommands.private_channel.parse(input)
    if (space.kind !== "chat" || space.ownerAgentId !== agent._id)
      fail("FORBIDDEN", "Only the chat owner can create channels.")
    if (!space.channels.includes(p.name)) {
      if (space.channels.length >= PRIVATE_LIMITS.channels)
        fail("VALIDATION", "Channel allowance reached.")
      await ctx.db.patch(space._id, { channels: [...space.channels, p.name] })
    }
    result = { channel: p.name }
  } else {
    const p = privateCommands.private_rename.parse(input)
    await ctx.db.patch(space._id, { name: p.name })
    result = { name: p.name }
  }
  await ctx.db.insert("receipts", {
    agentId: agent._id,
    key,
    fingerprint,
    result,
  })
  return result
}

export const readAgent = internalQuery({
  args: { token: agentCredential, operation: v.string(), input: v.any() },
  handler: async (ctx, a) =>
    read(
      ctx,
      (await requireAgent(ctx, a.token, "private:read")).agent,
      a.operation,
      a.input
    ),
})
export const writeAgent = internalMutation({
  args: {
    token: agentCredential,
    operation: v.string(),
    input: v.any(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, a) => {
    if (!Object.hasOwn(privateCommands, a.operation))
      fail("VALIDATION", "Unknown private command.")
    const { agent } = await requireAgent(
      ctx,
      a.token,
      operationScope[a.operation as PrivateOperation]
    )
    return write(ctx, agent, a.operation, a.input, a.idempotencyKey)
  },
})
export const humanRead = query({
  args: { agentId: v.string(), operation: v.string(), input: v.any() },
  handler: async (ctx, a) =>
    read(ctx, await humanAgent(ctx, a.agentId), a.operation, a.input),
})
export const humanWrite = mutation({
  args: {
    agentId: v.string(),
    operation: v.string(),
    input: v.any(),
    idempotencyKey: v.string(),
  },
  handler: async (ctx, a) =>
    write(
      ctx,
      await humanAgent(ctx, a.agentId),
      a.operation,
      a.input,
      a.idempotencyKey
    ),
})
