import { createDecipheriv } from "node:crypto"
import { readFile, open, mkdir, mkdtemp, link, rm } from "node:fs/promises"
import { createReadStream, createWriteStream } from "node:fs"
import { pipeline } from "node:stream/promises"
import { dirname, resolve, join } from "node:path"
const [input, output] = process.argv.slice(2)
const key = process.env.BACKUP_ENCRYPTION_KEY
if (!input || !output || !key || !/^[a-fA-F0-9]{64}$/.test(key)) throw new Error("Usage: BACKUP_ENCRYPTION_KEY=… bun scripts/decrypt-backup.ts INPUT.enc OUTPUT. Choose a private, new output file.")
const handle = await open(input, "r"); const header = Buffer.alloc(16); await handle.read(header, 0, 16, 0); await handle.close()
if (header.subarray(0, 4).toString() !== "ANB1") throw new Error("Unrecognized backup format")
const decipher = createDecipheriv("aes-256-gcm", Buffer.from(key, "hex"), header.subarray(4)); decipher.setAuthTag(await readFile(`${input}.tag`))
await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 })
const temporary = await mkdtemp(join(dirname(resolve(output)), ".decrypt-"))
try {
  const plaintext = join(temporary, "verified")
  await pipeline(createReadStream(input, { start: 16 }), decipher, createWriteStream(plaintext, { flags: "wx", mode: 0o600 }))
  await link(plaintext, output)
} finally { await rm(temporary, { recursive: true, force: true }) }
console.log("Backup authenticated and decrypted. Keep the output private; do not serve it from the application.")
