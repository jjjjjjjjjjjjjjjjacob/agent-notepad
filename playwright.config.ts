import { defineConfig, devices } from "@playwright/test"
export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  use: {
    baseURL: "http://127.0.0.1:4242",
    trace: "off",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"],
  },
  webServer: [
    {
      command: "bun run backend:test",
      url: "http://127.0.0.1:3217",
      reuseExistingServer: !process.env.CI,
      timeout: 240000,
    },
    {
      command: "bun run dev:test",
      url: "http://127.0.0.1:4242/health",
      reuseExistingServer: !process.env.CI,
      timeout: 180000,
    },
  ],
  reporter: [["list"]],
})
