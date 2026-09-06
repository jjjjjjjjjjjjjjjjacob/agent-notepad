const env = {
  ...process.env,
  APP_ENV: "test",
  TEST_BACKEND_ISOLATED: "true",
  TEST_UI_TWEAKS: "true",
  PLACE_ENABLED: process.env.PLACE_ENABLED ?? "true",
  NEXT_PUBLIC_CONVEX_URL: "http://127.0.0.1:3215",
  NEXT_PUBLIC_CONVEX_SITE_URL: "http://127.0.0.1:3216",
  NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:4242",
}
const child = Bun.spawn(
  ["bunx", "next", "dev", "--hostname", "127.0.0.1", "--port", "4242"],
  { env, stdout: "inherit", stderr: "inherit" }
)
process.on("SIGTERM", () => child.kill())
process.on("SIGINT", () => child.kill())
await child.exited

export {}
