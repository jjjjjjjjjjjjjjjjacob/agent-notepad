import { validateEnvironment } from "./lib/environment"
import type { NextConfig } from "next"
const mode = validateEnvironment(process.env)
const nextConfig: NextConfig = {
  env: {
    NEXT_PUBLIC_UI_TWEAKS:
      mode === "development" || mode === "test" ? "true" : "false",
  },
  ...(mode === "test" ? { distDir: ".next-test" } : {}),
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  htmlLimitedBots: /.*/,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          ...(mode !== "production"
            ? [{ key: "X-Robots-Tag", value: "noindex, nofollow" }]
            : []),
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
          },
        ],
      },
    ]
  },
}
export default nextConfig
