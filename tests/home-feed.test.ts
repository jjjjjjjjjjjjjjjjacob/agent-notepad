/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { api, internal } from "../convex/_generated/api"
import type { Id } from "../convex/_generated/dataModel"
import { digest } from "../lib/hash"
import { feedSignature } from "../lib/feed"
const modules = import.meta.glob("../convex/**/*.ts")
const page = { cursor: null, numItems: 20 }
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

async function setup() {
  const t = convexTest(schema, modules)
  const token = "homepage-test"
  const author = await t.mutation(internal.agents.create, {
    input: { name: "Researcher", slug: "researcher" },
    hash: digest(token),
    prefix: "test",
  })
  const command = (operation: string, input: unknown) =>
    t.mutation(internal.commands.execute, { token, operation, input })
  const community = (await command("create_space", {
    kind: "community",
    slug: "research",
    name: "Research",
  })) as {
    id: Id<"spaces">
    defaultChannel: { id: Id<"spaces">; slug: string }
  }
  const post = (await command("publish", {
    kind: "post",
    spaceId: community.id,
    title: "A finding",
    body: "An observation worth discussing.",
  })) as { id: Id<"resources">; slug: string; revisionId: Id<"revisions"> }
  return { t, author, command, community, post }
}

describe("homepage public data", () => {
  it("resolves current identities consistently through cards, details and REST", async () => {
    const { t, author, community, post } = await setup()
    const result = await t.query(api.public.listResources, {
      kind: "post",
      order: "popular",
      paginationOpts: page,
    })
    expect(result.items[0].space).toMatchObject({
      id: community.id,
      name: "Research",
      slug: "research",
    })
    expect(result.items[0].spaceId).toBe(community.id)
    const detail = await t.query(api.public.getResource, { slugOrId: post.id })
    expect(detail?.space).toEqual(result.items[0].space)
    await t.run(async (ctx) => {
      await ctx.db.patch(author.agentId, { name: "Renamed researcher" })
      await ctx.db.patch(community.id, { name: "Renamed community" })
    })
    const rest = await t.fetch("/api/v1/changes?limit=20")
    expect(rest.status).toBe(200)
    const changes = (await rest.json()).data.items
    expect(
      changes.find((event: { targetId: string }) => event.targetId === post.id)
    ).toMatchObject({
      actor: { name: "Renamed researcher" },
      targetPath: `/posts/${post.slug}?revision=${post.revisionId}`,
    })
    const cards = await t.query(api.public.listResources, {
      kind: "post",
      paginationOpts: page,
    })
    expect(cards.items[0].space?.name).toBe("Renamed community")
    expect(feedSignature(cards.items)).not.toBe(feedSignature(result.items))
  })

  it("links comments, channels, communities and valid revisions without fabricating missing destinations", async () => {
    const { t, command, community, post } = await setup()
    await command("comment", {
      resourceId: post.id,
      body: "Another observation.",
    })
    const channel = (await command("create_space", {
      kind: "channel",
      name: "Sources",
      slug: "sources",
      parentId: community.id,
    })) as { id: Id<"spaces"> }
    await t.run(async (ctx) => {
      await ctx.db.insert("events", {
        kind: "unknown",
        targetId: "unresolved",
        title: "Unresolved activity",
        suppressed: false,
      })
      await ctx.db.patch(post.revisionId, { suppressed: true })
    })
    const events = (await t.query(api.public.changes, { paginationOpts: page }))
      .items
    // A suppressed current revision makes its contribution unavailable; do not
    // expose cached article or comment metadata through the activity feed.
    expect(events.find((e) => e.kind === "comment")).toBeUndefined()
    expect(events.find((e) => e.targetId === channel.id)?.targetPath).toBe(
      "/chat/sources"
    )
    expect(events.find((e) => e.targetId === community.id)?.targetPath).toBe(
      "/communities/research"
    )
    expect(events.find((e) => e.kind === "published")).toBeUndefined()
    expect(events.find((e) => e.targetId === "unresolved")).toMatchObject({
      actor: null,
      targetPath: null,
    })
  })

  it("omits parent-suppressed contributions, channels and events and tolerates deleted actors", async () => {
    const { t, author, community, post } = await setup()
    await t.run((ctx) => ctx.db.delete(author.agentId))
    const before = (await t.query(api.public.changes, { paginationOpts: page }))
      .items
    expect(before.find((e) => e.targetId === post.id)?.actor).toBeNull()
    await t.run((ctx) => ctx.db.patch(community.id, { suppressed: true }))
    expect(
      (
        await t.query(api.public.listResources, {
          kind: "post",
          paginationOpts: page,
        })
      ).items
    ).toEqual([])
    expect(
      (await t.query(api.public.changes, { paginationOpts: page })).items
    ).toEqual([])
  })

  it("detects count-only changes and paginates both feed orders with matching signatures", async () => {
    const { t, command, post, community } = await setup()
    const args = {
      kind: "post" as const,
      order: "popular" as const,
      paginationOpts: page,
    }
    const before = await t.query(api.public.listResources, args)
    await command("comment", {
      resourceId: post.id,
      body: "A count-only change.",
    })
    const after = await t.query(api.public.listResources, args)
    expect(after.items[0].updatedAt).toBe(before.items[0].updatedAt)
    expect(feedSignature(after.items)).not.toBe(feedSignature(before.items))
    await t.run((ctx) => ctx.db.patch(post.id, { score: 3 }))
    expect(
      feedSignature((await t.query(api.public.listResources, args)).items)
    ).not.toBe(feedSignature(after.items))
    for (let i = 0; i < 21; i++)
      await command("publish", {
        kind: "post",
        spaceId: community.id,
        title: `Post ${i}`,
        body: "Another public observation.",
      })
    for (const order of ["new", "popular"] as const) {
      const first = await t.query(api.public.listResources, { ...args, order })
      const second = await t.query(api.public.listResources, {
        ...args,
        order,
        paginationOpts: { ...page, cursor: first.cursor },
      })
      expect(first.items).toHaveLength(20)
      expect(second.items).toHaveLength(2)
      expect(
        new Set([...first.items, ...second.items].map((i) => i.id)).size
      ).toBe(22)
      expect(
        feedSignature(
          (await t.query(api.public.listResources, { ...args, order })).items
        )
      ).toBe(feedSignature(first.items))
    }
    expect(feedSignature([])).toBe("[]")
  })
})
