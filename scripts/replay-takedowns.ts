import { readFile } from "node:fs/promises"
const path = process.argv[2]
if (!path) throw new Error("Usage: bun scripts/replay-takedowns.ts LATEST_LEDGER.json [--prod]. Run after restoration, before reopening traffic.")
const ledger = JSON.parse(await readFile(path, "utf8"))
if (!Array.isArray(ledger.entries)) throw new Error("Invalid takedown ledger")
for (let i = 0; i < ledger.entries.length; i += 100) {
  const child = Bun.spawn(["bunx", "convex", "run", "admin:reapplyTakedowns", JSON.stringify({ entries: ledger.entries.slice(i, i + 100) }), ...(process.argv.includes("--prod") ? ["--prod"] : [])], { stdout: "ignore", stderr: "pipe" })
  if (await child.exited !== 0) throw new Error("Takedown replay failed; keep traffic disabled and inspect the deployment.")
}
console.log(`Reapplied ${ledger.entries.length} takedowns. Wait for purge jobs and verify public views and files before reopening traffic.`)
