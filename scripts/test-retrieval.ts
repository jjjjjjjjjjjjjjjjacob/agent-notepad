import assert from "node:assert/strict"
import { mkdir, writeFile } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { z } from "zod"

// Read-only check of the deployed capybara corpus. A retrieval failure must fail
// this check: never mask it with a get_resource call or local fixture response.
const base = (
  process.env.RETRIEVAL_BASE_URL ??
  process.env.NEXT_PUBLIC_SITE_URL ??
  "http://localhost:3843"
).replace(/\/$/, "")
const requireHybrid = process.argv.includes("--require-hybrid")
const input = {
  query: "Capybaras in Japan history culture winter bathing",
  queries: [
    "Izu Shaboten Zoo capybara baths 1982 yuzu",
    "capybara bathing winter skin condition 2021 study",
  ],
  kind: "wiki",
  limit: 4,
  maxChars: 20000,
}
const responseSchema = z.object({
  data: z
    .object({
      mode: z.enum(["hybrid", "keyword"]),
      notice: z.string().nullable(),
      contextChars: z.number(),
      maxChars: z.number(),
      truncated: z.boolean(),
      returnedPassages: z.number(),
      queries: z.array(z.string()),
      items: z.array(
        z
          .object({
            id: z.string(),
            title: z.string(),
            revisionId: z.string(),
            revisionUrl: z.url(),
            citations: z.array(
              z
                .object({ number: z.number(), title: z.string(), url: z.url() })
                .passthrough()
            ),
            passages: z.array(
              z
                .object({
                  text: z.string(),
                  start: z.number(),
                  end: z.number(),
                  section: z.string().nullable(),
                })
                .passthrough()
            ),
          })
          .passthrough()
      ),
    })
    .passthrough(),
})

function verify(payload: unknown, transport: string, latencyMs: number) {
  const { data } = responseSchema.parse(payload)
  assert.deepEqual(
    data.queries,
    [input.query, ...input.queries],
    `${transport}: related queries were lost`
  )
  assert.equal(
    data.contextChars,
    JSON.stringify(data.items).length,
    `${transport}: incorrect context accounting`
  )
  assert(
    data.contextChars <= input.maxChars,
    `${transport}: context budget exceeded`
  )
  assert(
    data.items.length > 1,
    `${transport}: expected evidence from multiple articles`
  )
  const passages = data.items.flatMap((item) => item.passages)
  const text = passages.map((passage) => passage.text).join("\n")
  const expected = {
    bathingOrigin: /1982/,
    yuzuBaths: /yuzu/i,
    nativeRange: /South America/,
    bathingResearch: /skin/i,
  }
  for (const [fact, pattern] of Object.entries(expected))
    assert.match(text, pattern, `${transport}: missing answer span for ${fact}`)
  assert(
    passages.some((p) => p.section),
    `${transport}: heading metadata is missing; run retrieval:backfill`
  )
  for (const item of data.items) {
    assert(
      item.revisionUrl.includes(item.revisionId),
      `${transport}: citation does not pin the returned revision`
    )
    assert(
      item.citations.length,
      `${transport}: missing sources for ${item.title}`
    )
    for (const p of item.passages)
      assert.equal(
        p.end - p.start,
        p.text.length,
        `${transport}: incorrect passage offsets`
      )
  }
  if (requireHybrid) {
    assert.equal(
      data.mode,
      "hybrid",
      `${transport}: semantic retrieval is not enabled`
    )
    assert.equal(
      data.notice,
      null,
      `${transport}: semantic retrieval reported degraded coverage`
    )
  }
  return {
    transport,
    retrievalCalls: 1,
    latencyMs,
    mode: data.mode,
    notice: data.notice,
    resourceCount: data.items.length,
    passageCount: passages.length,
    contextChars: data.contextChars,
    truncated: data.truncated,
    answerSpans: Object.keys(expected),
    revisions: data.items.map((item) => ({
      title: item.title,
      url: item.revisionUrl,
    })),
  }
}

const params = new URLSearchParams({
  query: input.query,
  kind: input.kind,
  limit: String(input.limit),
  maxChars: String(input.maxChars),
})
for (const query of input.queries) params.append("queries", query)
const started = Date.now()
const response = await fetch(`${base}/api/v1/retrieve?${params}`, {
  signal: AbortSignal.timeout(60000),
})
assert(response.ok, `REST retrieval failed: HTTP ${response.status}`)
const rest = verify(await response.json(), "REST", Date.now() - started)
console.log(JSON.stringify(rest))

const client = new Client({
  name: "agent-notepad-retrieval-smoke",
  version: "1.0.0",
})
let mcp: ReturnType<typeof verify>
try {
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/mcp`))
  )
  const { tools } = await client.listTools()
  assert(
    tools.some(
      (tool) => tool.name === "get_retrieve" && tool.annotations?.readOnlyHint
    ),
    "MCP does not advertise get_retrieve"
  )
  const started = Date.now()
  const result = await client.callTool({
    name: "get_retrieve",
    arguments: input,
  })
  assert(
    !result.isError,
    `MCP retrieval failed: ${JSON.stringify(result.content)}`
  )
  mcp = verify(result.structuredContent, "MCP", Date.now() - started)
  console.log(JSON.stringify(mcp))
} finally {
  await client.close()
}
await mkdir(".artifacts", { recursive: true })
await writeFile(
  ".artifacts/retrieval-smoke.json",
  JSON.stringify(
    {
      base,
      testedAt: new Date().toISOString(),
      requireHybrid,
      results: [rest, mcp],
    },
    null,
    2
  )
)
console.log(
  "PASS: REST and MCP each returned all four expected answer spans in one retrieval call. Report: .artifacts/retrieval-smoke.json"
)
