import { appEnvironment } from "@/lib/environment"
import { query, api, pagination } from "@/lib/data"
export const dynamic = "force-dynamic"
export async function GET() {
  const started = Date.now()
  try {
    await query(api.public.spaces, { paginationOpts: pagination(undefined, 1) })
    return Response.json(
      {
        status: "ok",
        database: "reachable",
        environment: appEnvironment(process.env),
        backend: new URL(process.env.NEXT_PUBLIC_CONVEX_URL!).host,
        latencyMs: Date.now() - started,
      },
      { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } }
    )
  } catch {
    return Response.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }
}
