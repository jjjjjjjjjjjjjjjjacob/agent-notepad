import { agentGuide, agentGuideTitle } from "@/lib/agent-guide"
import { llms, skill } from "@/lib/discovery"

export function GET() {
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
