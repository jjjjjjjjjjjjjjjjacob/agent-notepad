export type AnalyticsEnvironment = Record<string, string | undefined>
export function analyticsConfig(env: AnalyticsEnvironment, browser = false) {
  const prefix = browser ? "NEXT_PUBLIC_" : ""
  const enabled = env[`${prefix}POSTHOG_ENABLED`] === "true"
  const verification = env[`${prefix}POSTHOG_VERIFICATION`] === "true"
  const production = browser
    ? env.NEXT_PUBLIC_APP_ENV === "production"
    : env.VERCEL_ENV
      ? env.VERCEL_ENV === "production"
      : env.APP_ENV === "production"
  const token = env[`${prefix}POSTHOG_PROJECT_TOKEN`] ?? ""
  const host = env[`${prefix}POSTHOG_HOST`] ?? "https://us.i.posthog.com"
  const validToken = /^phc_[A-Za-z0-9_-]{10,200}$/.test(token)
  return {
    enabled:
      enabled &&
      (production || verification) &&
      validToken &&
      host === "https://us.i.posthog.com",
    token,
    host,
    replay: env[`${prefix}POSTHOG_REPLAY_ENABLED`] === "true",
    environment: production
      ? ("production" as const)
      : ("verification" as const),
  }
}
export function validateAnalyticsEnvironment(env: AnalyticsEnvironment) {
  for (const prefix of ["", "NEXT_PUBLIC_"]) {
    for (const key of [
      "POSTHOG_ENABLED",
      "POSTHOG_REPLAY_ENABLED",
      "POSTHOG_VERIFICATION",
    ]) {
      const value = env[prefix + key]
      if (value !== undefined && !["true", "false"].includes(value))
        throw new Error(`${prefix}${key} must be true or false.`)
    }
    if (env[prefix + "POSTHOG_ENABLED"] !== "true") continue
    if (
      !/^phc_[A-Za-z0-9_-]{10,200}$/.test(
        env[prefix + "POSTHOG_PROJECT_TOKEN"] ?? ""
      )
    )
      throw new Error(
        `${prefix}POSTHOG_PROJECT_TOKEN is required when analytics is enabled.`
      )
    if (
      (env[prefix + "POSTHOG_HOST"] ?? "https://us.i.posthog.com") !==
      "https://us.i.posthog.com"
    )
      throw new Error(
        "Analytics must use the configured US PostHog ingestion host."
      )
  }
}
