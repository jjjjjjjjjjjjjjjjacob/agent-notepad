/// <reference types="vite/client" />
import { afterEach, describe, expect, it, vi } from "vitest"
import { convexTest } from "convex-test"
import schema from "../convex/schema"
import { validateEnvironment, allowedFrontendOrigin } from "../lib/environment"
import { validateProductionOperations } from "../lib/operations-config"
import { signGateway, GATEWAY_HEADER } from "../lib/gateway-security"
import { randomBytes } from "node:crypto"
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { encryptBackup, decryptBackup } from "../lib/backup-crypto"
const modules = import.meta.glob("../convex/**/*.ts")
afterEach(() => vi.unstubAllEnvs())
const production = {
  VERCEL_ENV: "production",
  NEXT_PUBLIC_CONVEX_URL: "https://gregarious-chickadee-782.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://api.agentnotepad.com/",
  NEXT_PUBLIC_SITE_URL: "https://agentnotepad.com/",
}
describe("production operations", () => {
  it("accepts only the configured production backend and custom HTTP origin", () => {
    expect(validateEnvironment(production)).toBe("production")
    expect(allowedFrontendOrigin("https://agentnotepad.com", production)).toBe(
      true
    )
    for (const value of [
      "https://gregarious-chickadee-782.convex.site",
      "https://incredible-boar-27.convex.site",
      "https://api.agentnotepad.com/path",
      "https://api.agentnotepad.com/?x=1",
      "https://evil@api.agentnotepad.com",
    ])
      expect(() =>
        validateEnvironment({
          ...production,
          NEXT_PUBLIC_CONVEX_SITE_URL: value,
        })
      ).toThrow()
    expect(() =>
      validateEnvironment({
        ...production,
        NEXT_PUBLIC_SITE_URL: "https://agent-notepad.vercel.app",
      })
    ).toThrow()
    expect(() =>
      validateEnvironment({ ...production, VERCEL_ENV: "preview" })
    ).toThrow()
  })
  it("requires an actual support address and independent gateway configuration", () => {
    const config = {
      PUBLIC_SUPPORT_EMAIL: "support@example.com",
      WRITE_GATEWAY_REQUIRED: "true",
      MODERATION_GATEWAY_SECRET: "a".repeat(64),
      MODERATION_IP_SECRET: "b".repeat(64),
    }
    expect(() => validateProductionOperations(config)).not.toThrow()
    expect(() =>
      validateProductionOperations({ ...config, PUBLIC_SUPPORT_EMAIL: "" })
    ).toThrow()
    expect(() =>
      validateProductionOperations({
        ...config,
        PUBLIC_SUPPORT_EMAIL: "bad\naddress",
      })
    ).toThrow()
    expect(() =>
      validateProductionOperations({
        ...config,
        WRITE_GATEWAY_REQUIRED: "false",
      })
    ).toThrow()
  })
  it("rejects direct writes and replay while allowing signed registration without the classifier", async () => {
    vi.stubEnv("WRITE_GATEWAY_REQUIRED", "true")
    vi.stubEnv("MODERATION_ENABLED", "false")
    vi.stubEnv("MODERATION_GATEWAY_SECRET", "gateway-test")
    const t = convexTest(schema, modules)
    const path = "/api/v1/agents",
      body = JSON.stringify({ name: "Gateway test agent" })
    expect((await t.fetch(path, { method: "POST", body })).status).toBe(403)
    const envelope = signGateway("gateway-test", {
      method: "POST",
      path,
      body,
      authorization: "",
      ipHash: "a".repeat(64),
      timestamp: Date.now(),
      nonce: randomBytes(32).toString("hex"),
    })
    const request = {
      method: "POST",
      body,
      headers: {
        "Content-Type": "application/json",
        [GATEWAY_HEADER]: JSON.stringify(envelope),
      },
    }
    expect((await t.fetch(path, request)).status).toBe(201)
    expect((await t.fetch(path, request)).status).toBe(403)
    expect((await t.fetch("/api/v1/agents")).status).toBe(200)
  })
  it("authenticates backups before releasing plaintext, rejects tampering, and preserves existing outputs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "backup-test-"))
    try {
      const source = join(dir, "source"),
        encrypted = join(dir, "backup.enc"),
        output = join(dir, "restored")
      const key = randomBytes(32),
        content = randomBytes(5000)
      await writeFile(source, content)
      await encryptBackup(source, encrypted, key)
      await decryptBackup(encrypted, output, key)
      expect(await readFile(output)).toEqual(content)
      expect((await stat(output)).mode & 0o777).toBe(0o600)
      await expect(decryptBackup(encrypted, output, key)).rejects.toThrow()
      expect(await readFile(output)).toEqual(content)
      await expect(
        decryptBackup(encrypted, join(dir, "wrong-key"), randomBytes(32))
      ).rejects.toThrow()
      await expect(stat(join(dir, "wrong-key"))).rejects.toThrow()
      const bytes = await readFile(encrypted)
      bytes[20] ^= 1
      await writeFile(encrypted, bytes)
      await expect(
        decryptBackup(encrypted, join(dir, "corrupted"), key)
      ).rejects.toThrow()
      await expect(stat(join(dir, "corrupted"))).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
