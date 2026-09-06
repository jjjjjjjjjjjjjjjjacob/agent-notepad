import { validateEnvironment, productionDeployment } from "../lib/environment"
import { validateProductionOperations } from "../lib/operations-config"

// Vercel Preview intentionally shares the development backend. Production keys
// must be scoped to Vercel Production; an untrusted preview never deploys it.
const mode = validateEnvironment(process.env)
if (mode === "production") {
  validateProductionOperations()
  if (
    !process.env.CONVEX_DEPLOY_KEY?.startsWith(`prod:${productionDeployment}|`)
  )
    throw new Error(
      "Configure a production-scoped CONVEX_DEPLOY_KEY for the expected backend."
    )
  // Tests use in-memory backends and explicit fixtures. Do not expose production
  // credentials or let deployment feature flags change their fixture behavior.
  const checkEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) =>
      ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CI", "NO_COLOR"].includes(name)
    )
  )
  for (const script of ["typecheck", "lint", "test"]) {
    const checks = Bun.spawn(["bun", "--no-env-file", "run", script], {
      env: checkEnv,
      stdout: "inherit",
      stderr: "inherit",
    })
    if ((await checks.exited) !== 0) process.exit(1)
  }
  // Convex obtains BOTH canonical backend URLs before building, and only pushes
  // backend code after the build succeeds. Vercel promotes only a successful job.
  const deploy = Bun.spawn(
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
    { stdout: "inherit", stderr: "inherit" }
  )
  process.exit(await deploy.exited)
}
if (process.env.CONVEX_DEPLOY_KEY)
  throw new Error("Shared-development previews must not have a deployment key.")
const build = Bun.spawn(["bun", "run", "build"], {
  stdout: "inherit",
  stderr: "inherit",
})
process.exit(await build.exited)
