/** Native Convex load test. Never connects to a configured cloud or production URL. */
import { readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
const directory = resolve(".artifacts/test-backend")
const config = JSON.parse(
  await readFile(
    resolve(directory, ".convex/local/default/config.json"),
    "utf8"
  )
) as { adminKey: string }
if (!config.adminKey) throw new Error("Start bun run backend:test first")
const code = (await readFile("scripts/fixtures/place-load.ts", "utf8"))
  .replaceAll('"../../convex/', '"./')
  .replaceAll('"../../lib/', '"../lib/')
await writeFile(resolve(directory, "convex/placeLoad.ts"), code)
type Metrics = Record<string, { used: number; remaining: number }>
type Reply = {
  result: Record<string, unknown>
  metrics: Metrics
  status: string
}
async function call<T>(path: string, args: unknown): Promise<T> {
  const response = await fetch("http://127.0.0.1:3215/api/mutation", {
    method: "POST",
    headers: {
      Authorization: `Convex ${config.adminKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ path, args, format: "json" }),
  })
  const body = (await response.json()) as {
    status: string
    value: T
    errorMessage?: string
  }
  if (body.status !== "success")
    throw new Error(body.errorMessage ?? `Mutation failed: ${response.status}`)
  return body.value
}
// Convex dev notices the fixture; wait only for its availability, not arbitrary settlement sleeps.
let actors: string[] | undefined
const run = Date.now().toString(36)
for (let i = 0; i < 30; i++) {
  try {
    actors = await call<string[]>("placeLoad:seed", { run })
    break
  } catch (error) {
    if (!String(error).includes("Could not find")) throw error
    await Bun.sleep(1000)
  }
}
if (!actors)
  throw new Error("The isolated backend did not load the native test fixture")
const maxima: Record<string, { used: number; remaining: number }> = {}
let calls = 0
function measure(metrics: Metrics) {
  calls++
  for (const [key, m] of Object.entries(metrics)) {
    if (!maxima[key] || m.used > maxima[key].used) maxima[key] = m
  }
}
async function command(agentId: string, operation: string, input: unknown) {
  const value = await call<Reply>("placeLoad:command", {
    agentId,
    operation,
    input,
  })
  measure(value.metrics)
  return value.result
}
async function advance(dealId: string) {
  for (let i = 0; i < 1000; i++) {
    const value = await call<Reply>("placeLoad:step", { dealId })
    measure(value.metrics)
    if (!["preparing", "settling"].includes(value.status)) {
      if (!["active", "committed"].includes(value.status))
        throw new Error(`Unexpected ${value.status}`)
      return value.status
    }
  }
  throw new Error("Preparation did not finish")
}
async function proposal(
  agentId: string,
  pixels: number[],
  kind: string,
  priceCents?: number
) {
  const draft = await command(agentId, "place_create", {
    kind,
    title: `Native ${run}`,
    pixelCount: pixels.length,
    ...(priceCents ? { priceCents } : {}),
  })
  const dealId = String(draft.dealId)
  for (let i = 0; i < pixels.length; i += 500)
    await command(agentId, "place_append", {
      dealId,
      pixels: pixels.slice(i, i + 500),
    })
  const sealed = await command(agentId, "place_seal", { dealId })
  return { dealId, termsHash: sealed.termsHash }
}
const start = performance.now(),
  pixels = Array.from(
    { length: 10000 },
    (_, i) => (i * 97 + Number(process.env.PLACE_LOAD_OFFSET ?? 0)) % 1000000
  ).sort((a, b) => a - b)
for (let i = 0; i < 32; i++) {
  const bundle = await proposal(
    actors[i],
    pixels.filter((_, j) => j % 32 === i),
    "initial"
  )
  await advance(bundle.dealId)
}
console.log(
  "32 sellers acquired 10,000 scattered coordinates on the isolated backend."
)
const sale = await proposal(actors[32], pixels, "offer", 100000)
for (const seller of actors.slice(0, 32))
  await command(seller, "place_approve", sale)
const before = await call<(string | null)[]>("placeLoad:owners", {
  pixels: [pixels[0], pixels.at(-1)!],
})
if (before.includes(actors[32]))
  throw new Error("Ownership changed before the atomic commit")
await advance(sale.dealId)
const after = await call<(string | null)[]>("placeLoad:owners", {
  pixels: [pixels[0], pixels.at(-1)!],
})
if (after.some((owner) => owner !== actors[32]))
  throw new Error("Committed ownership depends on background normalization")
let overloadRetries = 0
const painting = Array.from({ length: 32 }, async (_, i) => {
  const input = {
    pixels: pixels
      .slice(i * 16, i * 16 + 16)
      .map((pixel) => ({ pixel, color: 1 + (i % 15) })),
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await command(actors![32], "place_paint", input)
    } catch (error) {
      if (attempt >= 6 || !String(error).includes("Mutation failed: 503"))
        throw error
      overloadRetries++
      await Bun.sleep(100 * 2 ** attempt + Math.random() * 200)
    }
  }
})
const painted = await Promise.allSettled(painting)
if (painted.some((p) => p.status === "rejected"))
  throw new Error(
    `Concurrent painting failed: ${painted
      .filter((p) => p.status === "rejected")
      .map((p) => String(p.reason))
      .join("; ")}`
  )
const banId = await call<string>("placeLoad:banInventory", {
  agentId: actors[32],
})
const relinquished = await call<(string | null)[]>("placeLoad:owners", {
  pixels: [pixels[0], pixels.at(-1)!],
})
if (relinquished.some(Boolean))
  throw new Error("Ban control revocation waited for inventory cleanup")
type Inventory = { phase: string; pixels: number[]; cursor: string | null }
let done = false
for (let i = 0; i < 120; i++) {
  const state = await call<Inventory>("placeLoad:inventory", { banId })
  if (state.phase === "complete") {
    done = true
    break
  }
  await Bun.sleep(250)
}
if (!done)
  throw new Error("Native ban inventory did not recover within 30 seconds")
const forfeited = new Set<number>()
let cursor: string | null = null
do {
  const state: Inventory = await call<Inventory>("placeLoad:inventory", {
    banId,
    ...(cursor ? { cursor } : {}),
  })
  for (const pixel of state.pixels) {
    if (forfeited.has(pixel))
      throw new Error("Duplicate forfeiture lot membership")
    forfeited.add(pixel)
  }
  cursor = state.cursor
} while (cursor)
if (forfeited.size !== 10000 || pixels.some((pixel) => !forfeited.has(pixel)))
  throw new Error("Forfeiture inventory lost committed ownership")
const result = {
  run,
  sellers: 32,
  pixels: 10000,
  atomicBeforeNormalization: true,
  concurrentPaintBatches: 32,
  overloadRetries,
  forfeitedPixels: forfeited.size,
  calls,
  durationSeconds: Math.round((performance.now() - start) / 100) / 10,
  maxima,
}
await writeFile(".artifacts/place-load.json", JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
