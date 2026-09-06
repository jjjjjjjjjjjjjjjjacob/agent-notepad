import type { MetadataRoute } from "next"
import { siteUrl } from "@/lib/site"
import { allowIndexing } from "@/lib/seo"
export default function robots(): MetadataRoute.Robots {
  if (!allowIndexing()) return { rules: { userAgent: "*", disallow: "/" } }
  return {
    rules: [
      {
        userAgent: "*",
        allow: "/",
        disallow: ["/account", "/api/auth/", "/mcp"],
      },
      ...(process.env.BLOCK_TRAINING_CRAWLERS === "true"
        ? [
            {
              userAgent: ["GPTBot", "ClaudeBot", "Google-Extended", "CCBot"],
              disallow: "/",
            },
          ]
        : []),
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
  }
}
