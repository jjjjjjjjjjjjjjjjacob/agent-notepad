import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { mkdtemp, mkdir, chmod, readFile, writeFile, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { pipeline } from "node:stream/promises"
import { createReadStream, createWriteStream } from "node:fs"
const keyHex = process.env.BACKUP_ENCRYPTION_KEY
if (!keyHex || !/^[a-fA-F0-9]{64}$/.test(keyHex)) throw new Error("Set BACKUP_ENCRYPTION_KEY to a securely stored 32-byte hex key. It is never written to the backup.")
const key = Buffer.from(keyHex, "hex")
const production = process.argv.includes("--prod")
const flags = production ? ["--prod"] : []
const directory = resolve(process.env.BACKUP_DIRECTORY ?? ".artifacts/backups")
await mkdir(directory, { recursive: true, mode: 0o700 })
await chmod(directory, 0o700)
async function convex(args: string[]) {
  const process = Bun.spawn(["bunx", "convex", ...args, ...flags], { stdout: "pipe", stderr: "pipe" })
  const [output, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  if (code !== 0) throw new Error(`Convex command failed (${args[0]}): ${error.slice(0, 300)}`)
  return output
}
const entries: { action: string; targetId: string; actorId: string }[] = []
let cursor: string | undefined
// Capture the latest ledger separately. Keep it when restoring an older snapshot.
do {
  const page = JSON.parse(await convex(["run", "admin:takedownLedger", JSON.stringify(cursor ? { cursor } : {})]))
  entries.push(...page.entries); cursor = page.cursor ?? undefined
} while (cursor)
const stamp = new Date().toISOString().replaceAll(":", "-")
const temporary = await mkdtemp(join(tmpdir(), "agent-notepad-backup-"))
await chmod(temporary, 0o700)
async function encrypt(input: string, output: string) {
  const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv)
  await writeFile(output, Buffer.concat([Buffer.from("ANB1"), iv]), { mode: 0o600 })
  await pipeline(createReadStream(input), cipher, createWriteStream(output, { flags: "a", mode: 0o600 }))
  await writeFile(`${output}.tag`, cipher.getAuthTag(), { mode: 0o600 })
}
try {
  const snapshot = join(temporary, "snapshot.zip")
  await convex(["export", "--include-file-storage", "--path", snapshot])
  await chmod(snapshot, 0o600)
  const ledger = join(temporary, "ledger.json")
  await writeFile(ledger, JSON.stringify({ capturedAt: new Date().toISOString(), entries }), { mode: 0o600 })
  const snapshotPath = join(directory, `${stamp}.zip.enc`); const ledgerPath = join(directory, `${stamp}.ledger.enc`)
  await encrypt(snapshot, snapshotPath); await encrypt(ledger, ledgerPath)
  // Authenticate a round trip of the small ledger without printing any records.
  const encrypted = await readFile(ledgerPath); const decipher = createDecipheriv("aes-256-gcm", key, encrypted.subarray(4, 16)); decipher.setAuthTag(await readFile(`${ledgerPath}.tag`))
  JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(16)), decipher.final()]).toString())
  console.log(JSON.stringify({ snapshot: snapshotPath, ledger: ledgerPath, takedowns: entries.length, encrypted: "AES-256-GCM", verifiedLedger: true }, null, 2))
} finally { await rm(temporary, { recursive: true, force: true }) }
