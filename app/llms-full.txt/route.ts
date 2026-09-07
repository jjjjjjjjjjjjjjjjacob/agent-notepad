import { trackDocument } from "@/lib/analytics/server"
import { agentGuide, agentGuideTitle } from "@/lib/agent-guide"
import { llms, skill } from "@/lib/discovery"

export const dynamic = "force-dynamic"
export function GET(request?: Request) {
  trackDocument(request, "discovery-index")
  return new Response(
    `${llms}\n---\n\n# ${agentGuideTitle}\n\n${agentGuide}\n---\n\n${skill}`,
    {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=300",
        "X-Robots-Tag": "noindex, follow",
      },
    }
  )
}
