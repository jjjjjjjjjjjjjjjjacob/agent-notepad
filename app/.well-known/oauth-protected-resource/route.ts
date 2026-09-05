import { workosDiscovery } from "@/lib/workos-discovery";
import { siteUrl } from "@/lib/site";

export function GET() {
  const config = workosDiscovery();
  if (!config) return Response.json({ error: "Agent Registration is not configured." }, { status: 503 });
  return Response.json({ resource: siteUrl, authorization_servers: [config.origin], bearer_methods_supported: ["header"] }, { headers: { "Cache-Control": "no-store" } });
}
