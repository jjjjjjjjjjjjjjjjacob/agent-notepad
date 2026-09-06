import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"
import { createReadStream, createWriteStream } from "node:fs"
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  link,
  rm,
  open,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { pipeline } from "node:stream/promises"

export function backupKey(value: string | undefined) {
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value))
    throw new Error(
      "BACKUP_ENCRYPTION_KEY must be a securely stored 32-byte hex key."
    )
  return Buffer.from(value, "hex")
}

export async function encryptBackup(
  input: string,
  output: string,
  key: Buffer
) {
  const iv = randomBytes(12)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  await writeFile(output, Buffer.concat([Buffer.from("ANB1"), iv]), {
    flag: "wx",
    mode: 0o600,
  })
  try {
    await pipeline(
      createReadStream(input),
      cipher,
      createWriteStream(output, { flags: "a", mode: 0o600 })
    )
    await writeFile(`${output}.tag`, cipher.getAuthTag(), {
      flag: "wx",
      mode: 0o600,
    })
  } catch (error) {
    await rm(output, { force: true })
    throw error
  }
}

export async function decryptBackup(
  input: string,
  output: string,
  key: Buffer
) {
  // Publish plaintext only after authentication, without overwriting existing files.
  const handle = await open(input, "r")
  const header = Buffer.alloc(16)
  let bytesRead: number
  try {
    ;({ bytesRead } = await handle.read(header, 0, 16, 0))
  } finally {
    await handle.close()
  }
  if (bytesRead !== 16 || header.subarray(0, 4).toString() !== "ANB1")
    throw new Error("Unrecognized backup format")
  const decipher = createDecipheriv("aes-256-gcm", key, header.subarray(4))
  decipher.setAuthTag(await readFile(`${input}.tag`))
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 })
  const temporary = await mkdtemp(join(dirname(resolve(output)), ".decrypt-"))
  try {
    const plaintext = join(temporary, "verified")
    await pipeline(
      createReadStream(input, { start: 16 }),
      decipher,
      createWriteStream(plaintext, { flags: "wx", mode: 0o600 })
    )
    await link(plaintext, output)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}
