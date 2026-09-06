import { ConvexClient } from "convex/browser"
import { api } from "../convex/_generated/api"
const base = process.env.LOAD_BASE_URL ?? "http://127.0.0.1:4242"
const status = await (await fetch(`${base}/health`)).json()
if (status.environment !== "test" || status.backend !== "127.0.0.1:3215")
  throw new Error(
    "Load tests require the isolated test backend. Start bun run backend:test and bun run dev:test."
  )
const workers = Math.max(
  2,
  Math.min(Number(process.env.LOAD_WORKERS ?? 12), 30)
)
const run = crypto.randomUUID().slice(0, 8)
const latencies: number[] = []
let responseBytes = 0
let requests = 0
async function call(
  path: string,
  input?: unknown,
  token?: string,
  key?: string
) {
  const start = performance.now()
  const response = await fetch(`${base}/api/v1/${path}`, {
    method: input ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  })
  const text = await response.text()
  responseBytes += new TextEncoder().encode(text).length
  requests++
  latencies.push(performance.now() - start)
  const result = JSON.parse(text)
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${result.error?.code}`)
  return result.data
}
const identities = await Promise.all(
  Array.from({ length: workers + 1 }, (_, i) =>
    call("agents", {
      name: `Load test ${run} ${i}`,
      slug: `load-${run}-${i}`,
      bio: "Synthetic local load-test identity.",
    })
  )
)
const owner = identities[0]
const clients = identities.slice(1)
const topic = `load-${run}`
const pages = []
for (let i = 0; i < Math.floor(workers / 2); i++)
  pages.push(
    await call(
      "commands/publish",
      {
        kind: "wiki",
        title: `Load fixture ${run} ${i}`,
        slug: `load-${run}-article-${i}`,
        body: "Synthetic local contention fixture. Remove after the load test.",
        topic,
      },
      owner.apiKey,
      `publish-${i}`
    )
  )
const convexUrl = "http://127.0.0.1:3215"
const subscriptions: ConvexClient[] = []
const received: number[] = []
let changedAt = 0
await Promise.all(
  clients.map(async () => {
    const client = new ConvexClient(convexUrl)
    subscriptions.push(client)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Subscription handshake timeout")),
        15000
      )
      let baseline = false
      client.onUpdate(
        api.public.listResources,
        { kind: "wiki", topic, paginationOpts: { cursor: null, numItems: 25 } },
        (value) => {
          if (!baseline) {
            baseline = true
            clearTimeout(timer)
            resolve()
          } else if (
            changedAt &&
            value.items.some((item) => item.excerpt.includes("Fanout update"))
          )
            received.push(performance.now() - changedAt)
        }
      )
    })
  })
)
try {
  const claims = await Promise.all(
    clients.map((agent, i) =>
      call(
        "commands/request_work",
        { types: ["patrol"], topics: [topic], budgetMinutes: 1 },
        agent.apiKey,
        `claim-${i}`
      )
    )
  )
  const active = claims.filter((a) => a.status === "active")
  const taskIds = active.map((a) => a.taskId)
  if (new Set(taskIds).size !== taskIds.length)
    throw new Error("Two workers received the same task.")
  if (active.length !== pages.length)
    throw new Error(
      `Expected ${pages.length} leases; received ${active.length}.`
    )
  const retries = await Promise.all(
    clients.map((agent, i) =>
      call(
        "commands/request_work",
        { types: ["patrol"], topics: [topic], budgetMinutes: 1 },
        agent.apiKey,
        `claim-${i}`
      )
    )
  )
  if (retries.some((claim, i) => claim._id !== claims[i]._id))
    throw new Error("Retry created a second ticket.")
  changedAt = performance.now()
  await call(
    "commands/edit",
    {
      id: pages[0].id,
      baseRevisionId: pages[0].revisionId,
      body: "Fanout update. Synthetic local fixture.",
      summary: "Measure live update delivery",
    },
    owner.apiKey,
    "fanout-update"
  )
  const deadline = Date.now() + 10000
  while (received.length < workers && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 50))
  if (received.length < workers)
    throw new Error(
      `Only ${received.length}/${workers} subscribers received the update.`
    )
  const sorted = [...latencies].sort((a, b) => a - b)
  const fanout = [...received].sort((a, b) => a - b)
  const percentile = (values: number[], p: number) =>
    Math.round(
      values[Math.min(values.length - 1, Math.floor(values.length * p))]
    )
  const report = {
    at: new Date().toISOString(),
    target: base,
    workers,
    tasks: pages.length,
    uniqueLeases: new Set(taskIds).size,
    duplicateLeases: 0,
    stableRetries: retries.length,
    httpRequests: requests,
    httpResponseBytes: responseBytes,
    latencyMs: {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: Math.round(sorted.at(-1)!),
    },
    subscriptions: workers,
    liveUpdatesReceived: received.length,
    fanoutMs: { p50: percentile(fanout, 0.5), p95: percentile(fanout, 0.95) },
    billing:
      "Local measurements are not billing estimates. Inspect Convex function, database, storage and bandwidth meters plus Vercel usage on staging.",
  }
  await Bun.write(".artifacts/swarm-load.json", JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  await Promise.all(
    clients.map((agent, i) =>
      call(
        "commands/release_work",
        { assignmentId: claims[i]._id },
        agent.apiKey,
        `release-${i}`
      )
    )
  )
} finally {
  await Promise.all(subscriptions.map((client) => client.close()))
  await Promise.all(
    identities.map((agent) =>
      call("commands/revoke_key", { keyId: agent.keyId }, agent.apiKey)
    )
  )
}
