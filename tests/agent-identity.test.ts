/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import betterAuthTest from "@convex-dev/better-auth/test"
import schema from "../convex/schema"
import { api, components, internal } from "../convex/_generated/api"
import { digest } from "../lib/hash"

const modules = import.meta.glob("../convex/**/*.ts")
function setup() {
  const t = convexTest(schema, modules)
  betterAuthTest.register(t)
  return t
}
type Test = ReturnType<typeof setup>
async function human(t: Test, email = "owner@example.com") {
  const user = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "user",
      data: {
        name: "Owner",
        email,
        emailVerified: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  const session = await t.mutation(components.betterAuth.adapter.create, {
    input: {
      model: "session",
      data: {
        userId: user._id,
        token: `session-${email}`,
        expiresAt: Date.now() + 3600_000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    },
  })
  return {
    id: user._id,
    client: t.withIdentity({ subject: user._id, sessionId: session._id }),
  }
}
async function register(t: Test, input = {}) {
  const token = `an_${crypto.randomUUID()}`
  const agent = await t.mutation(internal.agents.create, {
    input,
    hash: digest(token),
    prefix: token.slice(0, 11),
  })
  return { ...agent, token }
}
async function createLink(t: Test, token: string) {
  const response = await t.fetch("/api/v1/agents/link", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  })
  expect(response.status).toBe(201)
  return (await response.json()).data as {
    linkingCode: string
    expiresAt: number
    name: string
    slug: string
  }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("agent names and runtime details", () => {
  it("registers through REST with a generated name and unique slug when both are omitted", async () => {
    const t = setup()
    const response = await t.fetch("/api/v1/agents", {
      method: "POST",
      body: "{}",
    })
    expect(response.status).toBe(201)
    const { data } = await response.json()
    expect(data.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(data.slug).toMatch(/^[a-z]+-[a-z]+-[0-9a-f]{8}$/)
    expect(data.apiKey).toMatch(/^an_/)
    const profile = await t.query(api.public.getAgent, { slug: data.slug })
    expect(profile).toMatchObject({
      name: data.name,
      provider: null,
      model: null,
      thinkingLevel: null,
    })
    const others = []
    for (let i = 0; i < 20; i++) others.push(await register(t))
    expect(new Set([data.slug, ...others.map((a) => a.slug)]).size).toBe(21)
  })

  it("honors chosen names/slugs, validates runtime details, and preserves identity on rename", async () => {
    const t = setup()
    const a = await register(t, {
      name: "My Agent",
      slug: "my-agent",
      provider: "Example AI",
      model: "example-reasoner",
      thinkingLevel: "high",
    })
    const contribution = (await t.mutation(internal.commands.execute, {
      token: a.token,
      operation: "publish",
      input: { kind: "note", title: "A note", body: "Public research" },
    })) as { id: string }
    await t.mutation(internal.commands.execute, {
      token: a.token,
      operation: "profile",
      input: { name: "Cedar", thinkingLevel: "low" },
    })
    expect(await t.query(api.public.getAgent, { slug: a.slug })).toMatchObject({
      id: a.agentId,
      name: "Cedar",
      slug: "my-agent",
      provider: "Example AI",
      model: "example-reasoner",
      thinkingLevel: "low",
    })
    expect(
      (await t.query(api.public.getResource, { slugOrId: contribution.id }))
        ?.author.name
    ).toBe("Cedar")
    await t.mutation(internal.commands.execute, {
      token: a.token,
      operation: "profile",
      input: { model: null, thinkingLevel: null },
    })
    expect(await t.query(api.public.getAgent, { slug: a.slug })).toMatchObject({
      provider: "Example AI",
      model: null,
      thinkingLevel: null,
    })
    await expect(register(t, { slug: a.slug })).rejects.toThrow("CONFLICT")
    await expect(register(t, { provider: " " })).rejects.toThrow("VALIDATION")
    await expect(
      t.mutation(internal.commands.execute, {
        token: a.token,
        operation: "profile",
        input: { name: " " },
      })
    ).rejects.toThrow("VALIDATION")
    const unicode = await register(t, { name: "研究者" })
    expect(unicode.name).toBe("研究者")
    expect(unicode.slug).toMatch(/^agent-/)
  })

  it("applies generated identities and runtime fields to WorkOS registration too", async () => {
    const t = setup()
    const agent = await t.mutation(internal.workosIdentity.provision, {
      identity: {
        registrationId: "agent_reg_generated",
        scopes: ["profile:write"],
        expiresAt: Date.now() + 60_000,
      },
      input: {
        provider: "Example AI",
        model: "example-small",
        thinkingLevel: "medium",
      },
    })
    expect(agent?.name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/)
    expect(
      await t.query(api.public.getAgent, { slug: agent!.slug })
    ).toMatchObject({
      provider: "Example AI",
      model: "example-small",
      thinkingLevel: "medium",
    })
  })
})

describe("separate human linking codes", () => {
  it("links once without sharing the API key, stores only a hash, and preserves contributions", async () => {
    const t = setup()
    const owner = await human(t)
    const other = await human(t, "other@example.com")
    const a = await register(t, {
      provider: "Example AI",
      model: "example-large",
      thinkingLevel: "high",
    })
    const link = await createLink(t, a.token)
    expect(link.linkingCode).toMatch(/^anlink_[A-Za-z0-9_-]{32}$/)
    expect(link.expiresAt).toBe(Date.now() + 15 * 60_000)
    const stored = await t.run((ctx) => ctx.db.query("agentLinks").collect())
    expect(stored).toHaveLength(1)
    expect(stored[0].hash).toBe(digest(link.linkingCode))
    expect(JSON.stringify(stored)).not.toContain(link.linkingCode)
    await expect(
      t.mutation(api.auth.linkAgent, { linkingCode: link.linkingCode })
    ).rejects.toThrow("UNAUTHORIZED")
    expect(
      await owner.client.mutation(api.auth.linkAgent, { linkingCode: a.token })
    ).toHaveProperty("error")
    await expect(
      t.mutation(internal.commands.execute, {
        token: link.linkingCode,
        operation: "profile",
        input: { name: "Imposter" },
      })
    ).rejects.toThrow("UNAUTHORIZED")
    expect(
      await owner.client.mutation(api.auth.linkAgent, {
        linkingCode: ` ${link.linkingCode} `,
      })
    ).toEqual({ id: a.agentId, name: a.name })
    expect(await owner.client.query(api.auth.linkedAgents, {})).toMatchObject([
      {
        id: a.agentId,
        provider: "Example AI",
        model: "example-large",
        thinkingLevel: "high",
      },
    ])
    expect(
      await other.client.mutation(api.auth.linkAgent, {
        linkingCode: link.linkingCode,
      })
    ).toHaveProperty("error")
    expect(
      await owner.client.mutation(api.auth.linkAgent, {
        linkingCode: link.linkingCode,
      })
    ).toHaveProperty("error")
    expect(
      await t.run((ctx) => ctx.db.query("agentLinks").collect())
    ).toHaveLength(0)
    // Ownership does not rotate or revoke the agent's private API credential.
    await expect(
      t.mutation(internal.commands.execute, {
        token: a.token,
        operation: "profile",
        input: { name: "Still me" },
      })
    ).resolves.toBeDefined()
    await owner.client.mutation(api.auth.revokeLinkedKey, { keyId: a.keyId })
    await expect(
      t.mutation(internal.commands.execute, {
        token: a.token,
        operation: "profile",
        input: { name: "Revoked" },
      })
    ).rejects.toThrow("UNAUTHORIZED")
    const publicProfile = await t.query(api.public.getAgent, { slug: a.slug })
    expect(publicProfile).not.toHaveProperty("ownerId")
    expect(publicProfile).not.toHaveProperty("keys")
  })

  it("invalidates old codes on replacement and rejects expired codes", async () => {
    const t = setup()
    const owner = await human(t)
    const a = await register(t)
    const old = await createLink(t, a.token)
    const current = await createLink(t, a.token)
    expect(current.linkingCode).not.toBe(old.linkingCode)
    expect(
      await owner.client.mutation(api.auth.linkAgent, {
        linkingCode: old.linkingCode,
      })
    ).toHaveProperty("error")
    vi.advanceTimersByTime(15 * 60_000)
    expect(
      await owner.client.mutation(api.auth.linkAgent, {
        linkingCode: current.linkingCode,
      })
    ).toHaveProperty("error")
    expect(
      (await t.run((ctx) => ctx.db.get(a.agentId)))?.ownerId
    ).toBeUndefined()
  })

  it.each(["revoked", "blocked", "owned", "workos"])(
    "rejects redemption when the agent becomes %s",
    async (condition) => {
      const t = setup()
      const owner = await human(t)
      const a = await register(t)
      const link = await createLink(t, a.token)
      await t.run(async (ctx) => {
        if (condition === "revoked")
          await ctx.db.patch(a.keyId, { revokedAt: Date.now() })
        if (condition === "blocked")
          await ctx.db.patch(a.agentId, { blocked: true })
        if (condition === "owned")
          await ctx.db.patch(a.agentId, { ownerId: "someone-else" })
        if (condition === "workos")
          await ctx.db.insert("agentRegistrations", {
            agentId: a.agentId,
            registrationId: "agent_reg_linked",
          })
      })
      expect(
        await owner.client.mutation(api.auth.linkAgent, {
          linkingCode: link.linkingCode,
        })
      ).toHaveProperty("error")
      await expect(
        t.action(internal.registration.createLink, { token: a.token })
      ).rejects.toThrow()
    }
  )

  it("requires keys:write and counts unsuccessful redemption attempts", async () => {
    const t = setup()
    const owner = await human(t)
    const a = await register(t)
    await t.mutation(internal.agents.issueKey, {
      tokenHash: digest(a.token),
      hash: digest("narrow-key"),
      prefix: "narrow",
      scopes: ["profile:write"],
      label: "Profile only",
    })
    await expect(
      t.action(internal.registration.createLink, { token: "narrow-key" })
    ).rejects.toThrow("FORBIDDEN")
    for (let i = 0; i < 10; i++)
      expect(
        await owner.client.mutation(api.auth.linkAgent, {
          linkingCode: "invalid",
        })
      ).toHaveProperty("error")
    await expect(
      owner.client.mutation(api.auth.linkAgent, { linkingCode: "invalid" })
    ).rejects.toThrow("RATE_LIMITED")
  })

  it("allows only one owner when two accounts redeem the same code concurrently", async () => {
    const t = setup()
    const first = await human(t)
    const second = await human(t, "second@example.com")
    const a = await register(t)
    const { linkingCode } = await createLink(t, a.token)
    const results = await Promise.all([
      first.client.mutation(api.auth.linkAgent, { linkingCode }),
      second.client.mutation(api.auth.linkAgent, { linkingCode }),
    ])
    expect(
      results.filter((result) => "id" in result && result.id)
    ).toHaveLength(1)
    expect(results.filter((result) => result.error)).toHaveLength(1)
    const saved = await t.run((ctx) => ctx.db.get(a.agentId))
    expect([first.id, second.id]).toContain(saved?.ownerId)
  })
})
