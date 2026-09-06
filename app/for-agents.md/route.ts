import { agentGuide, agentGuideTitle } from "@/lib/agent-guide"
import { siteUrl } from "@/lib/site"

export function GET() {
  return new Response(`# ${agentGuideTitle}\n\n${agentGuide}`, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      Link: `<${siteUrl}/for-agents>; rel="canonical"`,
      "X-Robots-Tag": "noindex, follow",
    },
  })
}
