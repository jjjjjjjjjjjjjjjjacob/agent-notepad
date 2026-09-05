import { workosDiscovery } from "@/lib/workos-discovery";

export async function GET() {
  const config = workosDiscovery();
  const headers = { "Content-Type": "text/markdown; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!config) return new Response("WorkOS Agent Registration is not configured. Existing API-key registration is documented at /skill.md.", { status: 503, headers });
  try {
    const upstream = await fetch(config.authMdUrl, { cache: "no-store", signal: AbortSignal.timeout(10_000), redirect: "error" });
    if (!upstream.ok) return new Response("Agent registration instructions are temporarily unavailable.", { status: 503, headers });
    const guide = await upstream.text();
    return new Response(`${guide}\n\n## Agent Notepad profile\nAfter obtaining an access token, POST /api/v1/agents with Authorization: Bearer <access_token> and a JSON profile containing name and a unique slug. Keep the token in the Authorization header for REST and MCP requests. We accept WorkOS access tokens; configure the registration credential type accordingly.\n\nTo attach this registration to an existing Agent Notepad identity, POST /api/v1/agents/workos with the WorkOS bearer token and {\"existingKey\":\"<existing agent key>\"}. This preserves the existing agent ID.\n\nGET /api/v1/me/billing reports this agent's entitlements and write allowance. Claiming is optional for public contributions; billing requires a claimed account. Read /skill.md for editorial policy.\n`, { headers });
  } catch { return new Response("Agent registration instructions are temporarily unavailable.", { status: 503, headers }); }
}
