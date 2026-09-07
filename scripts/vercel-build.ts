import {
  validateEnvironment,
  developmentDeployment,
  productionDeployment,
  type Environment,
} from "../lib/environment"
import { validateProductionOperations } from "../lib/operations-config"
import { validateAnalyticsEnvironment } from "../lib/analytics/config"

type RunCommand = (command: string[], env: Environment) => Promise<number>
const runCommand: RunCommand = async (command, env) => {
  const child = Bun.spawn(command, {
    env,
    stdout: "inherit",
    stderr: "inherit",
  })
  return child.exited
}

export async function buildForVercel(
  env: Environment = process.env,
  run: RunCommand = runCommand
) {
  // Only the dev branch may deploy the shared hosted development backend.
  // Other previews can build against it without receiving a deployment key.
  const mode = validateEnvironment(env)
  validateAnalyticsEnvironment(env)
  const deployDevelopment =
    env.VERCEL_ENV === "preview" && env.VERCEL_GIT_COMMIT_REF === "dev"
  if (mode === "production") {
    validateProductionOperations(env)
    const prefix = `prod:${productionDeployment}|`
    if (
      !env.CONVEX_DEPLOY_KEY?.startsWith(prefix) ||
      env.CONVEX_DEPLOY_KEY.length <= prefix.length
    )
      throw new Error(
        "Configure a production-scoped CONVEX_DEPLOY_KEY for the expected backend."
      )
  } else if (deployDevelopment) {
    const prefix = `dev:${developmentDeployment}|`
    if (
      !env.CONVEX_DEPLOY_KEY?.startsWith(prefix) ||
      env.CONVEX_DEPLOY_KEY.length <= prefix.length
    )
      throw new Error(
        "Configure a development-scoped CONVEX_DEPLOY_KEY for the dev branch only."
      )
    if (env.NEXT_PUBLIC_SITE_URL !== "https://dev.agentnotepad.com")
      throw new Error("The dev branch must use https://dev.agentnotepad.com.")
  } else if (env.CONVEX_DEPLOY_KEY) {
    throw new Error(
      "Other previews and local builds must not have a deployment key."
    )
  }

  // Tests use in-memory backends and explicit fixtures. Do not expose production
  // credentials or let deployment feature flags change their fixture behavior.
  const checkEnv = Object.fromEntries(
    Object.entries(env).filter(([name]) =>
      ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "CI", "NO_COLOR"].includes(name)
    )
  )
  for (const script of ["typecheck", "lint", "test"]) {
    const code = await run(["bun", "--no-env-file", "run", script], checkEnv)
    if (code !== 0) return code
  }

  if (mode !== "production" && !deployDevelopment)
    return run(["bun", "run", "build"], env)

  // Convex obtains BOTH canonical backend URLs before building, and only pushes
  // backend code after the build succeeds. Vercel promotes only a successful job.
  return run(
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
    env
  )
}

if (import.meta.main) process.exit(await buildForVercel())
