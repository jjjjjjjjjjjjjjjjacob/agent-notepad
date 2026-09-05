/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convexTest } from "convex-test";
import betterAuthTest from "@convex-dev/better-auth/test";
import Stripe from "stripe";
import type { AgentCredentialValidation, AgentRegistration } from "@workos-inc/node";
import schema from "../convex/schema";
import { api, components, internal } from "../convex/_generated/api";
import { digest } from "../lib/hash";
import { validatedAgentClaims } from "../lib/workos-agent";

const provider = vi.hoisted(() => ({
  validate: vi.fn(), registration: vi.fn(), user: vi.fn(), claim: vi.fn(),
  entitlements: vi.fn(), customer: vi.fn(), checkout: vi.fn(), subscriptions: vi.fn(), portal: vi.fn(),
}));
vi.mock("@workos-inc/node", () => ({ WorkOS: class {
  agents = { validateCredential: provider.validate, getRegistration: provider.registration, linkClaimAttemptToExternalUser: provider.claim };
  userManagement = { getUser: provider.user };
} }));
vi.mock("stripe", async importOriginal => {
  const actual = await importOriginal<typeof import("stripe")>();
  return { default: class extends actual.default {
    constructor(...args: ConstructorParameters<typeof actual.default>) {
      super(...args);
      this.entitlements.activeEntitlements.list = provider.entitlements;
      this.customers.create = provider.customer;
      this.checkout.sessions.create = provider.checkout;
      this.subscriptions.list = provider.subscriptions;
      this.billingPortal.sessions.create = provider.portal;
    }
  } };
});

const modules = import.meta.glob("../convex/**/*.ts");
function setup() { const t = convexTest(schema, modules); betterAuthTest.register(t); return t; }
type Test = ReturnType<typeof setup>;
const token = "test.workos.token";
const allScopes = "profile:write social:write wiki:write tasks:write keys:write moderation:write";
function fixtures(claimed = false, registrationId = "agent_reg_test") {
  const timestamp = new Date().toISOString();
  const registration: AgentRegistration = {
    id: registrationId, organizationId: "org_test", kind: "anonymous", status: claimed ? "verified" : "unverified",
    agentIdentity: { id: "agent_identity_test", userlandUserId: claimed ? "user_workos" : null, createdAt: timestamp, updatedAt: timestamp },
    claim: null, createdAt: timestamp, updatedAt: timestamp,
  };
  const validation: AgentCredentialValidation = { valid: true, registrationId, expiresAt: null, claims: {
    issuer: "https://test.authkit.app", audience: "client_test", registrationId, organizationId: "org_test",
    scope: allScopes, jti: "jti_test", expiresAt: Date.now() / 1000 + 3600, issuedAt: Date.now() / 1000,
    ...(claimed ? { actor: { sub: "user_workos" } } : {}),
  } };
  return { registration, validation };
}
function mockIdentity(claimed = false, ownerId = "owner_test", registrationId = "agent_reg_test") {
  const fixture = fixtures(claimed, registrationId);
  provider.validate.mockResolvedValue(fixture.validation);
  provider.registration.mockResolvedValue(fixture.registration);
  provider.user.mockResolvedValue({ externalId: ownerId });
  return fixture;
}
async function request(t: Test, path: string, input?: unknown, credential = token) {
  return t.fetch(`/api/v1/${path}`, { method: input === undefined ? "GET" : "POST", headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}), "Content-Type": "application/json" }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
}
async function register(t: Test, slug = "workos-agent") {
  const response = await request(t, "agents", { name: "Test Agent", slug });
  expect(response.status).toBe(201);
  return (await response.json()).data as { agentId: string; registrationId: string; claimed: boolean };
}
async function human(t: Test, email = "owner@example.com") {
  const user = await t.mutation(components.betterAuth.adapter.create, { input: { model: "user", data: { name: "Owner", email, emailVerified: true, createdAt: Date.now(), updatedAt: Date.now() } } });
  const session = await t.mutation(components.betterAuth.adapter.create, { input: { model: "session", data: { userId: user._id, token: `session-${email}`, expiresAt: Date.now() + 3600_000, createdAt: Date.now(), updatedAt: Date.now() } } });
  return { id: user._id as string, client: t.withIdentity({ subject: user._id, sessionId: session._id }) };
}
function stripeEvent(id: string, customer = "cus_test") {
  const body = JSON.stringify({ id, object: "event", type: "entitlements.active_entitlement_summary.updated", livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { customer, active_entitlements: [] } } });
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: body, secret: "whsec_test" });
  return { body, signature };
}
async function webhook(t: Test, id: string) {
  const event = stripeEvent(id);
  return t.fetch("/stripe/webhook", { method: "POST", headers: { "stripe-signature": event.signature }, body: event.body });
}

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks();
  vi.stubEnv("WORKOS_API_KEY", "sk_test_workos"); vi.stubEnv("WORKOS_CLIENT_ID", "client_test");
  vi.stubEnv("WORKOS_AUTHKIT_ISSUER", "https://test.authkit.app"); vi.stubEnv("WORKOS_AGENT_AUDIENCE", "client_test");
  vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_stripe"); vi.stubEnv("STRIPE_PRICE_ID", "price_test"); vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test"); vi.stubEnv("SITE_URL", "http://localhost:3000");
  mockIdentity();
  provider.entitlements.mockImplementation(async function* () {});
  provider.subscriptions.mockImplementation(async function* () {});
  provider.customer.mockResolvedValue({ id: "cus_test" });
  provider.checkout.mockResolvedValue({ url: "https://checkout.stripe.com/test" });
  provider.portal.mockResolvedValue({ url: "https://billing.stripe.com/test" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("WorkOS agent authentication and ownership", () => {
  it("runs anonymous registration → public contribution → human claim → paid access with the same ID", async () => {
    const t = setup(); const owner = await human(t);
    const registered = await register(t);
    const published = await request(t, "commands/publish", { kind: "note", title: "Before claiming", body: "A public notebook entry." });
    expect(published.status).toBe(200);
    const noteId = (await published.json()).data.id;
    provider.claim.mockResolvedValue({ userCode: "ABCD-EFGH" });
    expect(await owner.client.action(api.workos.claim, { claimAttemptToken: "attempt_test" })).toEqual({ userCode: "ABCD-EFGH" });
    expect(provider.claim).toHaveBeenCalledWith({ claimAttemptToken: "attempt_test", user: { email: "owner@example.com", externalId: owner.id } });
    mockIdentity(true, owner.id);
    const afterClaim = await request(t, "me/billing");
    expect((await afterClaim.json()).data).toMatchObject({ agentId: registered.agentId, claimed: true, writeLimitPerMinute: 60 });
    expect(await owner.client.action(api.stripe.checkout, {})).toEqual({ url: "https://checkout.stripe.com/test" });
    provider.entitlements.mockImplementation(async function* () { yield { lookup_key: "higher_write_limits" }; });
    expect((await webhook(t, "evt_upgrade")).status).toBe(200);
    expect((await (await request(t, "me/billing")).json()).data).toMatchObject({ agentId: registered.agentId, writeLimitPerMinute: 300 });
    expect((await t.query(api.public.getResource, { slugOrId: noteId }))?.revision.author.id).toBe(registered.agentId);
    expect(await t.run(ctx => ctx.db.query("agents").collect())).toHaveLength(1);
    expect(await t.run(ctx => ctx.db.query("keys").collect())).toHaveLength(0);
    expect(provider.validate).toHaveBeenCalledWith({ type: "access_token", credential: token, audience: "client_test", checkForRevoked: true });
    provider.entitlements.mockImplementation(async function* () {});
    expect((await webhook(t, "evt_downgrade")).status).toBe(200);
    expect((await (await request(t, "me/billing")).json()).data.writeLimitPerMinute).toBe(60);
  });

  it("keeps legacy two-request registration and publishing working", async () => {
    const t = setup();
    const registered = await request(t, "agents", { name: "Legacy", slug: "legacy-agent" }, "");
    const key = (await registered.json()).data.apiKey;
    expect(key).toMatch(/^an_/);
    expect((await request(t, "agents", { name: "Second legacy", slug: "second-legacy" }, key)).status).toBe(201);
    expect((await request(t, "commands/publish", { kind: "note", title: "Legacy note", body: "Still works." }, key)).status).toBe(200);
    expect(provider.validate).not.toHaveBeenCalled();
  });

  it("preserves an existing agent's ID when attaching WorkOS and rejects a second agent", async () => {
    const t = setup();
    const legacy = await t.mutation(internal.agents.create, { input: { name: "Existing", slug: "existing-agent" }, hash: digest("legacy-key"), prefix: "legacy" });
    const response = await request(t, "agents/workos", { existingKey: "legacy-key" });
    expect(response.status).toBe(200);
    expect((await response.json()).data.agentId).toBe(legacy.agentId);
    const second = await t.mutation(internal.agents.create, { input: { name: "Other", slug: "other-agent" }, hash: digest("other-key"), prefix: "other" });
    expect(second.agentId).not.toBe(legacy.agentId);
    expect((await request(t, "agents/workos", { existingKey: "other-key" })).status).toBe(409);
  });

  it("rejects invalid, expired, revoked, wrong-audience and wrong-issuer credentials", async () => {
    const t = setup(); await register(t);
    for (const change of ["invalid", "expired", "revoked", "audience", "issuer"] as const) {
      const fixture = mockIdentity();
      if (change === "invalid") provider.validate.mockResolvedValue({ valid: false, claims: null });
      if (change === "expired") fixture.validation.claims!.expiresAt = Date.now() / 1000 - 1;
      if (change === "revoked") fixture.registration.status = "revoked";
      if (change === "audience") fixture.validation.claims!.audience = "other_app";
      if (change === "issuer") fixture.validation.claims!.issuer = "https://attacker.example";
      expect((await request(t, "commands/profile", { bio: "Attempt" })).status, change).toBe(401);
    }
  });

  it("enforces scopes and local roles and refuses caller-provided identity fields", async () => {
    const t = setup(); const registered = await register(t);
    mockIdentity().validation.claims!.scope = "profile:write";
    expect((await request(t, "commands/publish", { kind: "note", title: "Denied", body: "Denied" })).status).toBe(403);
    mockIdentity();
    expect((await request(t, "commands/moderate_agent", { agentId: registered.agentId, blocked: true, reason: "No moderator role" })).status).toBe(403);
    expect((await request(t, "agents", { name: "Forged", slug: "forged", ownerId: "owner", scopes: allScopes })).status).toBe(400);
    await expect(t.query(api.public.myWork, { token: { registrationId: "agent_reg_test", scopes: allScopes.split(" "), expiresAt: Date.now() + 1000 } } as never)).rejects.toThrow();
  });

  it("rejects old pre-claim credentials, ownership changes and locally revoked registrations", async () => {
    const t = setup(); const owner = await human(t); await register(t);
    mockIdentity(true, owner.id); expect((await request(t, "me/billing")).status).toBe(200);
    const fixture = mockIdentity(true, owner.id); delete fixture.validation.claims!.actor;
    expect((await request(t, "me/billing")).status).toBe(401);
    mockIdentity(true, "different-owner"); expect((await request(t, "me/billing")).status).toBe(409);
    mockIdentity(true, owner.id);
    const bindings = await owner.client.query(api.workosIdentity.registrations, {});
    const intruder = await human(t, "intruder@example.com");
    await expect(intruder.client.mutation(api.workosIdentity.revoke, { id: bindings[0].id })).rejects.toThrow("FORBIDDEN");
    await owner.client.mutation(api.workosIdentity.revoke, { id: bindings[0].id });
    expect((await request(t, "me/billing")).status).toBe(401);
  });

  it("requires human login before claiming or managing billing", async () => {
    const t = setup();
    await expect(t.action(api.workos.claim, { claimAttemptToken: "attempt" })).rejects.toThrow("UNAUTHORIZED");
    await expect(t.action(api.stripe.checkout, {})).rejects.toThrow("UNAUTHORIZED");
    await expect(t.action(api.stripe.portal, {})).rejects.toThrow("UNAUTHORIZED");
    expect(provider.claim).not.toHaveBeenCalled(); expect(provider.customer).not.toHaveBeenCalled();
  });
});

describe("Stripe payment authorization", () => {
  it("checks real webhook signatures before calling Stripe or modifying billing", async () => {
    const t = setup(); const event = stripeEvent("evt_forged");
    const response = await t.fetch("/stripe/webhook", { method: "POST", headers: { "stripe-signature": event.signature }, body: event.body.replace("cus_test", "cus_other") });
    expect(response.status).toBe(400); expect(provider.entitlements).not.toHaveBeenCalled();
    expect(await t.run(ctx => ctx.db.query("billingEvents").collect())).toHaveLength(0);
  });

  it("does not reuse another account's customer or accept live billing credentials", async () => {
    const t = setup(); const a = await human(t); const b = await human(t, "second@example.com");
    const first = await a.client.mutation(internal.billing.forCheckout, {});
    const second = await b.client.mutation(internal.billing.forCheckout, {});
    await t.mutation(internal.billing.attachCustomer, { accountId: first.id, customerId: "cus_test" });
    await expect(t.mutation(internal.billing.attachCustomer, { accountId: second.id, customerId: "cus_test" })).rejects.toThrow("CONFLICT");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_live_not_allowed");
    await expect(a.client.action(api.stripe.checkout, {})).rejects.toThrow("NOT_CONFIGURED");
    expect(provider.checkout).not.toHaveBeenCalled();
  });

  it("ignores duplicate events and prevents older reconciliations restoring removed access", async () => {
    const t = setup(); const owner = await human(t);
    const account = await owner.client.mutation(internal.billing.forCheckout, {});
    await t.mutation(internal.billing.attachCustomer, { accountId: account.id, customerId: "cus_test" });
    const older = (await t.mutation(internal.billing.beginSync, { customerId: "cus_test", eventId: "evt_old" }))!;
    const newer = (await t.mutation(internal.billing.beginSync, { customerId: "cus_test", eventId: "evt_new" }))!;
    await t.mutation(internal.billing.finishSync, { ...newer, customerId: "cus_test", eventId: "evt_new", entitlements: [] });
    expect(await t.mutation(internal.billing.finishSync, { ...older, customerId: "cus_test", eventId: "evt_old", entitlements: ["higher_write_limits"] })).toBe(false);
    expect(await t.mutation(internal.billing.beginSync, { customerId: "cus_test", eventId: "evt_new" })).toBeNull();
    expect((await owner.client.query(api.billing.current, {}))?.entitlements).toEqual([]);
  });

  it("applies paid quotas to agent writes and returns to free quotas when entitlement is removed", async () => {
    const t = setup(); mockIdentity(true); const registered = await register(t);
    const identity = await t.action(internal.workos.authenticate, { token });
    const account = await t.run(ctx => ctx.db.query("billingAccounts").first());
    await t.run(async ctx => {
      await ctx.db.patch(account!._id, { entitlements: ["higher_write_limits"] });
      await ctx.db.insert("limits", { bucket: `write:${registered.agentId}`, count: 60, resetAt: Date.now() + 60_000 });
    });
    await expect(t.mutation(internal.commands.execute, { token: identity, operation: "profile", input: { bio: "Paid write" } })).resolves.toBeDefined();
    await t.run(ctx => ctx.db.patch(account!._id, { entitlements: [] }));
    await expect(t.mutation(internal.commands.execute, { token: identity, operation: "profile", input: { bio: "Free limit" } })).rejects.toThrow("RATE_LIMITED");
  });
});

describe("WorkOS claim validation", () => {
  it("rejects a token for a different live registration or organization", () => {
    const fixture = fixtures();
    fixture.registration.organizationId = "org_other";
    expect(() => validatedAgentClaims(fixture.validation, fixture.registration, { issuer: "https://test.authkit.app", audience: "client_test" })).toThrow();
  });
});
