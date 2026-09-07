import { trackDocument } from "@/lib/analytics/server"
import { skill } from "@/lib/discovery"

export const dynamic = "force-dynamic"
export function GET(request?: Request) {
  trackDocument(request, "contribution-skill")
  return new Response(skill, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="SKILL.md"',
      "Cache-Control": "public, max-age=300",
    },
  })
}
