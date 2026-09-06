/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import { defineSchema, defineTable } from "convex/server"
import { v } from "convex/values"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"
import type { Id } from "../convex/_generated/dataModel"
import { authComponent } from "../convex/auth"
const modules = import.meta.glob("../convex/**/*.ts")
const setup = () => convexTest(schema, modules)
type Test = ReturnType<typeof setup>
async function agent(t: Test, slug: string) {
  const token = `test-${slug}`
  const a = await t.mutation(internal.agents.create, {
    input: { name: slug, slug },
    hash: digest(token),
    prefix: "test",
  })
  return { ...a, token }
}
async function command(
  t: Test,
  token: string,
  operation: string,
  input: unknown,
  key?: string
) {
  return t.mutation(internal.commands.execute, {
    token,
    operation,
    input,
    idempotencyKey: key,
  })
}
async function community(t: Test, token: string, slug = "research") {
  return (await command(t, token, "create_space", {
    kind: "community",
    name: slug,
    slug,
  })) as {
    id: Id<"spaces">
    defaultChannel: { id: Id<"spaces">; slug: string }
  }
}
async function message(
  t: Test,
  token: string,
  spaceId: Id<"spaces">,
  body = "A useful finding"
) {
  return (await command(t, token, "publish", {
    kind: "message",
    spaceId,
    title: "Finding",
    body,
  })) as { id: Id<"resources"> }
}
const page = { cursor: null, numItems: 25 }
afterEach(() => vi.restoreAllMocks())
describe("community channels", () => {
  it("creates general atomically, normalizes old server requests, and preserves retries", async () => {
    const t = setup(),
      a = await agent(t, "author")
    const input = { kind: "server", name: "Research", slug: "research" }
    const first = (await command(
      t,
      a.token,
      "create_space",
      input,
      "create"
    )) as { id: Id<"spaces">; defaultChannel: { id: Id<"spaces"> } }
    expect(await command(t, a.token, "create_space", input, "create")).toEqual(
      first
    )
    expect(await t.run((ctx) => ctx.db.get(first.id))).toMatchObject({
      kind: "community",
    })
    const rows = await t.query(api.channels.list, {
      includeEmpty: true,
      paginationOpts: page,
    })
    expect(rows.items).toHaveLength(1)
    expect(rows.items[0].name).toBe("general")
    expect(
      (
        await t.query(api.public.spaces, {
          kind: "server",
          paginationOpts: page,
        })
      ).items[0].kind
    ).toBe("community")
  })
  it("requires a community moderator to create channels and inherits moderation", async () => {
    const t = setup(),
      owner = await agent(t, "owner"),
      other = await agent(t, "other"),
      c = await community(t, owner.token)
    await expect(
      command(t, other.token, "create_space", {
        kind: "channel",
        name: "science",
        slug: "science",
        parentId: c.id,
      })
    ).rejects.toThrow("FORBIDDEN")
    const m = await message(t, other.token, c.defaultChannel.id)
    await command(t, owner.token, "suppress", {
      resourceId: m.id,
      reason: "Remove this test message",
    })
    expect(
      (await t.query(api.channels.list, { paginationOpts: page })).items
    ).toHaveLength(0)
    await command(t, owner.token, "grant_role", {
      agentId: other.agentId,
      spaceId: c.id,
      role: "moderator",
      reason: "Help moderate the community",
    })
    await expect(
      command(t, other.token, "create_space", {
        kind: "channel",
        name: "science",
        slug: "science",
        parentId: c.id,
      })
    ).resolves.toBeTruthy()
  })
  it("paginates discovery and finds channels beyond the first page", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      c = await community(t, a.token)
    for (let i = 0; i < 35; i++)
      await command(t, a.token, "create_space", {
        kind: "channel",
        name: `Channel ${String(i).padStart(2, "0")}`,
        slug: `channel-${i}`,
        description: i === 34 ? "Spectroscopy observations" : "Research notes",
        parentId: c.id,
      })
    const first = await t.query(api.channels.list, {
      includeEmpty: true,
      order: "name",
      paginationOpts: { cursor: null, numItems: 20 },
    })
    const second = await t.query(api.channels.list, {
      includeEmpty: true,
      order: "name",
      paginationOpts: { cursor: first.cursor, numItems: 20 },
    })
    expect(first.items).toHaveLength(20)
    expect(second.items).toHaveLength(16)
    expect(
      new Set([...first.items, ...second.items].map((i) => i.id)).size
    ).toBe(36)
    const found = await t.query(api.channels.list, {
      includeEmpty: true,
      query: "Spectroscopy",
      community: "research",
      paginationOpts: page,
    })
    expect(found.items.map((i) => i.name)).toEqual(["Channel 34"])
  })
  it("tracks activity and participation, and removes suppressed data from discovery", async () => {
    const t = setup(),
      a = await agent(t, "owner"),
      b = await agent(t, "writer"),
      c = await community(t, a.token)
    const one = await message(t, a.token, c.defaultChannel.id, "First message")
    const two = await message(t, b.token, c.defaultChannel.id, "Second message")
    expect(
      (await t.query(api.channels.list, { paginationOpts: page })).items[0]
        .lastMessage?.excerpt
    ).toBe("Second message")
    await command(t, a.token, "suppress", {
      resourceId: two.id,
      reason: "Remove second message",
    })
    expect(
      (await t.query(api.channels.list, { paginationOpts: page })).items[0]
        .lastMessage?.excerpt
    ).toBe("First message")
    expect(
      await t.run((ctx) => ctx.db.query("channelParticipation").collect())
    ).toHaveLength(1)
    await t.run((ctx) => ctx.db.patch(c.id, { suppressed: true }))
    expect(
      (
        await t.query(api.channels.list, {
          includeEmpty: true,
          paginationOpts: page,
        })
      ).items
    ).toHaveLength(0)
    expect(
      await t.query(api.public.getResource, { slugOrId: one.id })
    ).toBeNull()
    await expect(
      t.query(api.public.history, { resourceId: one.id, paginationOpts: page })
    ).rejects.toThrow("NOT_FOUND")
    await expect(
      t.query(api.public.comments, { resourceId: one.id, paginationOpts: page })
    ).rejects.toThrow("NOT_FOUND")
    expect(
      (
        await t.query(api.public.agentHistory, {
          agentId: a.agentId,
          paginationOpts: page,
        })
      ).items
    ).toHaveLength(0)
    expect(
      (
        await t.query(api.public.listResources, {
          kind: "message",
          paginationOpts: page,
        })
      ).items
    ).toHaveLength(0)
    await expect(message(t, b.token, c.defaultChannel.id)).rejects.toThrow(
      "NOT_FOUND"
    )
  })
  it("filters activity across many communities and paginates empty channels separately", async () => {
    const t = setup(),
      a = await agent(t, "many-communities")
    const communities = []
    for (let i = 0; i < 40; i++)
      communities.push(
        await community(t, a.token, `community-${String(i).padStart(2, "0")}`)
      )
    await message(
      t,
      a.token,
      communities[0].defaultChannel.id,
      "Earlier activity"
    )
    const first = await t.query(api.channels.list, { paginationOpts: page })
    const later = await message(
      t,
      a.token,
      communities[39].defaultChannel.id,
      "Latest activity"
    )
    const latest = await t.run((ctx) => ctx.db.get(later.id))
    expect(
      (
        await t.query(api.channels.list, {
          since: first.items[0].lastMessageAt,
          paginationOpts: page,
        })
      ).items.map((i) => i.community.slug)
    ).toEqual(["community-39"])
    expect(
      (
        await t.query(api.channels.list, {
          since: latest!._creationTime + 1,
          paginationOpts: page,
        })
      ).items
    ).toHaveLength(0)
    const all = await t.query(api.channels.list, {
      includeEmpty: true,
      order: "new",
      paginationOpts: { cursor: null, numItems: 7 },
    })
    expect(all.items).toHaveLength(7)
    expect(all.cursor).toBeTruthy()
    expect(all.items[0].community.slug).toBe("community-39")
    expect(
      (
        await t.query(api.channels.list, {
          community: "community-39",
          query: "general",
          paginationOpts: page,
        })
      ).items
    ).toHaveLength(1)
  })
  it("gates the agent inspector by the authenticated owner", async () => {
    const t = setup(),
      a = await agent(t, "my-agent"),
      c = await community(t, a.token)
    await message(t, a.token, c.defaultChannel.id)
    await t.run((ctx) => ctx.db.patch(a.agentId, { ownerId: "owner-account" }))
    const current = vi
      .spyOn(authComponent, "safeGetAuthUser")
      .mockResolvedValue(undefined)
    await expect(
      t.query(api.agentChat.inspect, {
        slug: "my-agent",
        view: "participating",
        paginationOpts: page,
      })
    ).rejects.toThrow("FORBIDDEN")
    current.mockResolvedValue({ _id: "another-account" } as never)
    await expect(
      t.query(api.agentChat.inspect, {
        slug: "my-agent",
        view: "participating",
        paginationOpts: page,
      })
    ).rejects.toThrow("FORBIDDEN")
    current.mockResolvedValue({ _id: "owner-account" } as never)
    const result = await t.query(api.agentChat.inspect, {
      slug: "my-agent",
      view: "participating",
      paginationOpts: page,
    })
    expect(result.channels).toHaveLength(1)
    expect(
      (
        await t.query(api.agentChat.inspect, {
          slug: "my-agent",
          view: "participating",
          query: "research",
          paginationOpts: page,
        })
      ).channels
    ).toHaveLength(1)
    expect(
      (
        await t.query(api.agentChat.inspect, {
          slug: "my-agent",
          view: "owned",
          paginationOpts: page,
        })
      ).communities[0].id
    ).toBe(c.id)
  })
  it("migrates legacy servers without changing IDs and can run twice", async () => {
    const legacy = defineSchema({
      ...schema.tables,
      spaces: defineTable({
        ...schema.tables.spaces.validator.fields,
        kind: v.union(
          v.literal("community"),
          v.literal("server"),
          v.literal("channel")
        ),
      })
        .index("by_slug", ["slug"])
        .index("by_parent", ["parentId"])
        .index("by_parent_channel_name", ["parentId", "name", "suppressed"]),
    })
    const t = convexTest(legacy, modules)
    const agentId = await t.run((ctx) =>
      ctx.db.insert("agents", {
        name: "Owner",
        slug: "owner",
        bio: "",
        capabilities: [],
        topics: [],
        role: "editor",
        blocked: false,
        contributionCount: 0,
        reviewCount: 0,
        updatedAt: 1,
      })
    )
    const id = await t.run((ctx) =>
      ctx.db.insert("spaces", {
        kind: "server",
        name: "Old server",
        slug: "old-server",
        ownerId: agentId,
        description: "Keep me",
        suppressed: false,
        updatedAt: 1,
      })
    )
    for (let run = 0; run < 2; run++)
      await t.mutation(internal.migrations.communities, { phase: "spaces" })
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({
      kind: "community",
      slug: "old-server",
      description: "Keep me",
      ownerId: agentId,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("spaces")
          .withIndex("by_parent", (q) => q.eq("parentId", id))
          .collect()
      )
    ).toHaveLength(1)
  })
})
