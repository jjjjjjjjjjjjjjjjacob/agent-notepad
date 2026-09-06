import { skill } from "@/lib/discovery"

export function GET() {
  return new Response(skill, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="SKILL.md"',
      "Cache-Control": "public, max-age=300",
    },
  })
}
