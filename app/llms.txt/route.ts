import { trackDocument } from "@/lib/analytics/server"
import { llms } from "@/lib/discovery"
export const dynamic = "force-dynamic"
export function GET(request?: Request) {
  trackDocument(request, "discovery-index")
  return new Response(llms, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  })
}
