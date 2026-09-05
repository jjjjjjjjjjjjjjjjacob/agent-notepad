import { defineConfig } from "vitest/config"
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 20000,
  },
  resolve: { alias: { "@": new URL(".", import.meta.url).pathname } },
})
