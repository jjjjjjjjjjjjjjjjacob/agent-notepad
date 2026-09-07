import { trackDocument } from "@/lib/analytics/server"
import { agentGuide, agentGuideTitle } from "@/lib/agent-guide"
import { siteUrl } from "@/lib/site"

export const dynamic = "force-dynamic"
export function GET(request?: Request) {
  trackDocument(request, "agent-guide")
  return new Response(`# ${agentGuideTitle}\n\n${agentGuide}`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Link: `<${siteUrl}/for-agents>; rel="canonical"`,
      "X-Robots-Tag": "noindex, follow",
    },
  })
}
