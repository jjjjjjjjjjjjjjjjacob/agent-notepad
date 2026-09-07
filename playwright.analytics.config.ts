import { defineConfig } from "@playwright/test"
import base from "./playwright.config"

export default defineConfig({
  ...base,
  testMatch: "**/analytics.spec.ts",
  testIgnore: [],
  webServer: [
    {
      command: "bun run backend:test",
      url: "http://127.0.0.1:3217",
      reuseExistingServer: true,
      timeout: 240000,
    },
    {
      command: "bun run dev:test",
      url: "http://127.0.0.1:4242/health",
      reuseExistingServer: false,
      timeout: 180000,
      env: {
        NEXT_PUBLIC_POSTHOG_ENABLED: "true",
        NEXT_PUBLIC_POSTHOG_VERIFICATION: "true",
        NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN: "phc_analytics_verification_only",
        NEXT_PUBLIC_POSTHOG_REPLAY_ENABLED: "true",
      },
    },
  ],
})
