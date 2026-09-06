import {
  mkdtemp,
  mkdir,
  chmod,
  readFile,
  writeFile,
  rm,
} from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { backupKey, encryptBackup, decryptBackup } from "../lib/backup-crypto"

const key = backupKey(process.env.BACKUP_ENCRYPTION_KEY)
const production = process.argv.includes("--prod")
const ledgerOnly = process.argv.includes("--ledger-only")
const flags = production
  ? ["--deployment-name", "gregarious-chickadee-782"]
  : []
if (
  process.env.CONVEX_DEPLOY_KEY &&
  production &&
  !process.env.CONVEX_DEPLOY_KEY.startsWith("prod:gregarious-chickadee-782|")
)
  throw new Error("Refusing to export an unexpected production deployment.")
const directory = resolve(process.env.BACKUP_DIRECTORY ?? ".artifacts/backups")
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
async function convex(args: string[]) {
  const child = Bun.spawn(["bunx", "convex", ...args, ...flags], {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [output, , code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0)
    throw new Error(
      `Convex ${args[0]} failed. Inspect the deployment privately.`
    )
  return output
}
const temporary = await mkdtemp(join(tmpdir(), "agent-notepad-backup-"))
await chmod(temporary, 0o700)
const stamp = new Date().toISOString().replaceAll(":", "-")
const runDirectory = await mkdtemp(join(directory, `${stamp}-`))
const outputs: string[] = []
try {
  if (!ledgerOnly) {
    const snapshot = join(temporary, "snapshot.zip")
    await convex(["export", "--include-file-storage", "--path", snapshot])
    await chmod(snapshot, 0o600)
    const output = join(runDirectory, "snapshot.zip.enc")
    outputs.push(output, `${output}.tag`)
    await encryptBackup(snapshot, output, key)
    await decryptBackup(output, join(temporary, "verified.zip"), key)
  }
  // Read after export, including removals made while taking the snapshot.
  // Hourly ledger-only runs preserve newer takedowns for older snapshots.
  const entries: { action: string; targetId: string; actorId: string }[] = []
  let cursor: string | undefined
  do {
    const page = JSON.parse(
      await convex([
        "run",
        "admin:takedownLedger",
        JSON.stringify(cursor ? { cursor } : {}),
      ])
    )
    entries.push(...page.entries)
    cursor = page.cursor ?? undefined
  } while (cursor)
  const ledger = join(temporary, "ledger.json")
  await writeFile(
    ledger,
    JSON.stringify({
      capturedAt: new Date().toISOString(),
      deployment: production ? "gregarious-chickadee-782" : "development",
      entries,
    }),
    { mode: 0o600 }
  )
  const ledgerPath = join(runDirectory, "ledger.enc")
  outputs.push(ledgerPath, `${ledgerPath}.tag`)
  await encryptBackup(ledger, ledgerPath, key)
  const verified = join(temporary, "verified-ledger.json")
  await decryptBackup(ledgerPath, verified, key)
  JSON.parse(await readFile(verified, "utf8"))
  console.log(
    JSON.stringify({
      files: outputs,
      takedowns: entries.length,
      encrypted: "AES-256-GCM",
      verified: true,
      ledgerOnly,
    })
  )
} catch (error) {
  await rm(runDirectory, { recursive: true, force: true })
  throw error
} finally {
  await rm(temporary, { recursive: true, force: true })
}
