import { describe, expect, it, vi } from "vitest"
import { buildForVercel } from "../scripts/vercel-build"
import type { Environment } from "../lib/environment"

const production: Environment = {
  VERCEL_ENV: "production",
  APP_ENV: "production",
  NEXT_PUBLIC_CONVEX_URL: "https://gregarious-chickadee-782.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://api.agentnotepad.com",
  NEXT_PUBLIC_SITE_URL: "https://agentnotepad.com",
  CONVEX_DEPLOY_KEY: "prod:gregarious-chickadee-782|test-only",
  PUBLIC_SUPPORT_EMAIL: "support@example.com",
  WRITE_GATEWAY_REQUIRED: "true",
  MODERATION_GATEWAY_SECRET: "a".repeat(64),
  MODERATION_IP_SECRET: "b".repeat(64),
  PATH: "/usr/bin",
  CI: "1",
}
const preview: Environment = {
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "feature/example",
  NEXT_PUBLIC_CONVEX_URL: "https://incredible-boar-27.convex.cloud",
  NEXT_PUBLIC_CONVEX_SITE_URL: "https://incredible-boar-27.convex.site",
  NEXT_PUBLIC_SITE_URL: "https://agent-notepad-development.vercel.app",
}
const development: Environment = {
  ...preview,
  VERCEL_GIT_COMMIT_REF: "dev",
  NEXT_PUBLIC_SITE_URL: "https://dev.agentnotepad.com",
  CONVEX_DEPLOY_KEY: "dev:incredible-boar-27|test-only",
}
const runner = () =>
  vi
    .fn<(command: string[], env: Environment) => Promise<number>>()
    .mockResolvedValue(0)

describe("Vercel release gate", () => {
  it.each([
    { CONVEX_DEPLOY_KEY: undefined },
    { CONVEX_DEPLOY_KEY: "prod:gregarious-chickadee-782|" },
    { CONVEX_DEPLOY_KEY: "prod:another-deployment|test-only" },
    { CONVEX_DEPLOY_KEY: "dev:incredible-boar-27|test-only" },
    { PUBLIC_SUPPORT_EMAIL: undefined },
    { NEXT_PUBLIC_CONVEX_SITE_URL: preview.NEXT_PUBLIC_CONVEX_SITE_URL },
    {
      NEXT_PUBLIC_POSTHOG_ENABLED: "true",
      NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "",
    },
  ])(
    "rejects invalid production configuration before running commands: %j",
    async (overrides) => {
      const run = runner()
      await expect(
        buildForVercel({ ...production, ...overrides }, run)
      ).rejects.toThrow()
      expect(run).not.toHaveBeenCalled()
    }
  )

  it("keeps credentials and production flags out of validation subprocesses", async () => {
    const run = runner()
    expect(await buildForVercel(production, run)).toBe(0)
    const checks = run.mock.calls.slice(0, 3)
    expect(checks.map(([command]) => command)).toEqual(
      ["typecheck", "lint", "test"].map((script) => [
        "bun",
        "--no-env-file",
        "run",
        script,
      ])
    )
    for (const [, env] of checks)
      expect(env).toEqual({ PATH: "/usr/bin", CI: "1" })
    const [command, env] = run.mock.calls[3]
    expect(command).toEqual([
      "bunx",
      "convex",
      "deploy",
      "--yes",
      "--cmd-url-env-var-name",
      "NEXT_PUBLIC_CONVEX_URL",
      "--cmd",
      "bun run build",
    ])
    expect(env).toBe(production)
  })

  it.each([0, 1, 2])(
    "stops a production release when validation step %i fails",
    async (failure) => {
      const run = runner()
      for (let i = 0; i < failure; i++) run.mockResolvedValueOnce(0)
      run.mockResolvedValueOnce(17)
      expect(await buildForVercel(production, run)).toBe(17)
      expect(run).toHaveBeenCalledTimes(failure + 1)
      expect(
        run.mock.calls.some(([command]) => command.includes("deploy"))
      ).toBe(false)
    }
  )

  it("propagates a failed coordinated build/deployment to Vercel", async () => {
    const run = runner()
    run
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    expect(await buildForVercel(production, run)).toBe(1)
  })

  it("validates previews, builds the frontend, and never deploys the shared backend", async () => {
    const run = runner()
    expect(await buildForVercel(preview, run)).toBe(0)
    expect(run).toHaveBeenCalledTimes(4)
    expect(run.mock.lastCall).toEqual([["bun", "run", "build"], preview])
    expect(run.mock.calls.some(([command]) => command.includes("deploy"))).toBe(
      false
    )
  })

  it("coordinates the dev branch frontend and hosted development backend", async () => {
    const run = runner()
    expect(await buildForVercel(development, run)).toBe(0)
    expect(run.mock.calls.slice(0, 3).map(([, env]) => env)).toEqual([
      {},
      {},
      {},
    ])
    expect(run.mock.lastCall).toEqual([
      [
        "bunx",
        "convex",
        "deploy",
        "--yes",
        "--cmd-url-env-var-name",
        "NEXT_PUBLIC_CONVEX_URL",
        "--cmd",
        "bun run build",
      ],
      development,
    ])
  })

  it.each([
    { CONVEX_DEPLOY_KEY: undefined },
    { CONVEX_DEPLOY_KEY: "dev:incredible-boar-27|" },
    { CONVEX_DEPLOY_KEY: production.CONVEX_DEPLOY_KEY },
    { CONVEX_DEPLOY_KEY: "dev:another-deployment|test-only" },
    { NEXT_PUBLIC_SITE_URL: "http://localhost:3843" },
    { VERCEL_GIT_COMMIT_REF: "feature/example" },
    { VERCEL_GIT_COMMIT_REF: undefined },
    { VERCEL_ENV: "development" },
    { VERCEL_ENV: "production" },
  ])("rejects invalid dev release configuration: %j", async (overrides) => {
    const run = runner()
    await expect(
      buildForVercel({ ...development, ...overrides }, run)
    ).rejects.toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it.each([0, 1, 2, 3])(
    "propagates failure at dev release step %i",
    async (failure) => {
      const run = runner()
      for (let i = 0; i < failure; i++) run.mockResolvedValueOnce(0)
      run.mockResolvedValueOnce(17)
      expect(await buildForVercel(development, run)).toBe(17)
      expect(run).toHaveBeenCalledTimes(failure + 1)
    }
  )

  it("refuses any deploy key in a shared preview, even if APP_ENV says production", async () => {
    const run = runner()
    await expect(
      buildForVercel(
        {
          ...preview,
          APP_ENV: "production",
          CONVEX_DEPLOY_KEY: production.CONVEX_DEPLOY_KEY,
        },
        run
      )
    ).rejects.toThrow("must not have a deployment key")
    expect(run).not.toHaveBeenCalled()
  })
})
