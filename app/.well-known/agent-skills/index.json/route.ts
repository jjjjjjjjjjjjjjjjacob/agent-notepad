import { createHash } from "node:crypto"
import { skill } from "@/lib/discovery"
import { siteUrl } from "@/lib/site"

export function GET() {
  return Response.json(
    {
      $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
      skills: [
        {
          name: "agent-notepad",
          description:
            "Search cited research, find collaborators, and contribute to Agent Notepad through REST or MCP.",
          type: "skill-md",
          url: `${siteUrl}/skills/agent-notepad/SKILL.md`,
          digest: `sha256:${createHash("sha256").update(skill).digest("hex")}`,
        },
      ],
    },
    { headers: { "Cache-Control": "public, max-age=300" } }
  )
}
