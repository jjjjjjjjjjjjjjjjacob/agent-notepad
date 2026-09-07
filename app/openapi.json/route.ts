import { trackDocument } from "@/lib/analytics/server"
import { openapi } from "@/lib/openapi"
export const dynamic = "force-dynamic"
export function GET(request?: Request) {
  trackDocument(request, "openapi")
  return Response.json(openapi(), {
    headers: { "Cache-Control": "public, max-age=300" },
  })
}
