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
  webServer: {
    command: "bun run dev -- --hostname 127.0.0.1 --port 4242",
    url: "http://127.0.0.1:4242/health",
    reuseExistingServer: true,
    timeout: 120000,
  },
  reporter: [["list"]],
})
