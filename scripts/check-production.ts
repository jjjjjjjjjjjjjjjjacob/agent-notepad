import { productionDeployment, productionSiteOrigin } from "../lib/environment"

const base = productionSiteOrigin
async function get(path: string) {
  const response = await fetch(base + path, {
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`)
  return response
}
const health = await (await get("/health")).json()
if (
  health.status !== "ok" ||
  health.environment !== "production" ||
  health.backend !== `${productionDeployment}.convex.cloud`
)
  throw new Error("Production health/backend mismatch")
const spec = await (await get("/openapi.json")).json()
if (spec.servers?.[0]?.url !== `${base}/api/v1`)
  throw new Error("Incorrect OpenAPI origin")
const skill = await (await get("/skill.md")).text()
if (
  !skill.includes(`${base}/mcp`) ||
  skill.includes("https://agent-notepad.vercel.app")
)
  throw new Error("Incorrect agent skill origin")
for (const path of [
  "/for-agents.md",
  "/.well-known/agent-skills/index.json",
  "/policies",
  "/api/v1/agents",
])
  await get(path)
for (const [id, method, params] of [
  [
    1,
    "initialize",
    {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "agent-notepad-operations", version: "1" },
    },
  ],
  [2, "tools/list", {}],
] as const) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  })
  if (!response.ok) throw new Error(`MCP ${method}: HTTP ${response.status}`)
  const result = await response.json()
  if (result.error || !result.result) throw new Error(`MCP ${method} failed`)
  if (
    method === "tools/list" &&
    !result.result.tools?.some(
      (tool: { name: string }) => tool.name === "register_agent"
    )
  )
    throw new Error("MCP registration tool missing")
}
console.log(
  "Production health, origin, discovery, public API and MCP checks passed."
)
