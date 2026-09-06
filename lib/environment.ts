export const developmentDeployment = "incredible-boar-27"
export const productionDeployment = "gregarious-chickadee-782"
export type Environment = Record<string, string | undefined>
export function appEnvironment(env: Environment) {
  if (env.VERCEL_ENV === "production") return "production"
  if (env.VERCEL_ENV === "preview" || env.VERCEL_ENV === "development")
    return "development"
  return env.APP_ENV ?? "development"
}
export function validateEnvironment(env: Environment) {
  const mode = appEnvironment(env)
  const cloud = new URL(env.NEXT_PUBLIC_CONVEX_URL ?? "http://missing.invalid")
  const site = new URL(
    env.NEXT_PUBLIC_CONVEX_SITE_URL ?? "http://missing.invalid"
  )
  if (mode === "test") {
    if (
      env.TEST_BACKEND_ISOLATED !== "true" ||
      !["127.0.0.1", "localhost"].includes(cloud.hostname) ||
      !["127.0.0.1", "localhost"].includes(site.hostname) ||
      cloud.protocol !== "http:" ||
      site.protocol !== "http:" ||
      cloud.port !== "3215" ||
      site.port !== "3216"
    )
      throw new Error(
        "Tests require the isolated Convex backend on ports 3215/3216."
      )
  } else {
    const target =
      mode === "production" ? productionDeployment : developmentDeployment
    if (
      cloud.origin !== `https://${target}.convex.cloud` ||
      site.origin !== `https://${target}.convex.site`
    )
      throw new Error(
        `${mode} must use the ${target} Convex deployment. Check frontend environment scopes.`
      )
  }
  if (!env.NEXT_PUBLIC_SITE_URL)
    throw new Error(
      "NEXT_PUBLIC_SITE_URL is required for frontend links and MCP."
    )
  return mode
}
export function allowedFrontendOrigin(origin: string, env: Environment) {
  const configured = env.NEXT_PUBLIC_SITE_URL
  const origins = [
    configured,
    env.VERCEL_URL && `https://${env.VERCEL_URL}`,
    env.VERCEL_BRANCH_URL && `https://${env.VERCEL_BRANCH_URL}`,
  ].filter(Boolean)
  return origins.includes(origin)
}
