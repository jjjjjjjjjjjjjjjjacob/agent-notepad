import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { encryptBackup } from "../lib/backup-crypto"
import {
  backupStorage,
  uploadEncryptedBackup,
  type AwsCommand,
} from "../scripts/lib/backup-storage"

const config = {
  bucket: "agentnotepad-test-backups",
  accountId: "123456789012",
  region: "us-east-1",
}
async function fixture(full = false) {
  const dir = await mkdtemp(join(tmpdir(), "backup-storage-test-"))
  const source = join(dir, "plaintext")
  await writeFile(source, "Synthetic private fixture, never uploaded.")
  const key = randomBytes(32)
  await encryptBackup(source, join(dir, "ledger.enc"), key)
  if (full) await encryptBackup(source, join(dir, "snapshot.zip.enc"), key)
  await rm(source)
  return dir
}
function storage(
  options: {
    account?: string
    public?: boolean
    unblock?: boolean
    corrupt?: boolean
    failPut?: boolean
  } = {}
) {
  const objects = new Map<string, Buffer>()
  const calls: string[][] = []
  const aws: AwsCommand = async (args) => {
    calls.push(args)
    const value = (flag: string) => args[args.indexOf(flag) + 1]
    switch (args[1]) {
      case "get-caller-identity":
        return { Account: options.account ?? config.accountId }
      case "get-public-access-block":
        return {
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: !options.unblock,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }
      case "get-bucket-policy-status":
        return { PolicyStatus: { IsPublic: options.public ?? false } }
      case "put-object": {
        expect(value("--expected-bucket-owner")).toBe(config.accountId)
        expect(value("--if-none-match")).toBe("*")
        expect(value("--server-side-encryption")).toBe("AES256")
        if (options.failPut || objects.has(value("--key")))
          throw new Error("Upload denied")
        objects.set(value("--key"), await readFile(value("--body")))
        return {}
      }
      case "get-object": {
        const bytes = objects.get(value("--key"))
        if (!bytes) throw new Error("Missing object")
        await writeFile(
          args.at(-1)!,
          options.corrupt ? Buffer.from("corrupt") : bytes
        )
        return {}
      }
      default:
        throw new Error("Unexpected AWS operation")
    }
  }
  return { aws, objects, calls }
}

describe("private backup storage", () => {
  it("requires an explicit bucket, account and standard AWS region", () => {
    expect(
      backupStorage({
        BACKUP_S3_BUCKET: config.bucket,
        BACKUP_AWS_ACCOUNT_ID: config.accountId,
        AWS_REGION: config.region,
      })
    ).toEqual(config)
    for (const change of [
      {},
      { BACKUP_S3_BUCKET: "--endpoint-url" },
      { BACKUP_AWS_ACCOUNT_ID: "wrong" },
      { AWS_REGION: "https://other.example" },
    ]) {
      const env = Object.keys(change).length
        ? {
            BACKUP_S3_BUCKET: config.bucket,
            BACKUP_AWS_ACCOUNT_ID: config.accountId,
            AWS_REGION: config.region,
            ...change,
          }
        : {}
      expect(() => backupStorage(env)).toThrow()
    }
  })
  it("uploads only encrypted pairs, verifies remote bytes, then publishes the completion marker", async () => {
    const dir = await fixture(true)
    const remote = storage()
    try {
      expect(
        await uploadEncryptedBackup(dir, config, remote.aws)
      ).toMatchObject({ verified: true, files: 4 })
      expect(remote.objects.size).toBe(5)
      const puts = remote.calls.filter((args) => args[1] === "put-object")
      expect(puts.at(-1)?.join(" ")).toContain("complete.json")
      for (const [key, bytes] of remote.objects) {
        expect(bytes.toString()).not.toContain("Synthetic private fixture")
        if (key.endsWith(".enc"))
          expect(bytes.subarray(0, 4).toString()).toBe("ANB1")
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
  it.each(["plaintext", "missing-tag", "short-tag", "extra-file", "symlink"])(
    "rejects %s before contacting AWS",
    async (mode) => {
      const dir = await fixture()
      const remote = storage()
      try {
        if (mode === "plaintext")
          await writeFile(
            join(dir, "ledger.enc"),
            "this is plaintext, not an encrypted backup"
          )
        if (mode === "missing-tag") await rm(join(dir, "ledger.enc.tag"))
        if (mode === "short-tag")
          await writeFile(join(dir, "ledger.enc.tag"), "bad")
        if (mode === "extra-file")
          await writeFile(join(dir, "snapshot.zip"), "private")
        if (mode === "symlink") {
          await rm(join(dir, "ledger.enc.tag"))
          await symlink(join(dir, "ledger.enc"), join(dir, "ledger.enc.tag"))
        }
        await expect(
          uploadEncryptedBackup(dir, config, remote.aws)
        ).rejects.toThrow()
        expect(remote.calls).toHaveLength(0)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
  it.each([{ account: "999999999999" }, { public: true }, { unblock: true }])(
    "rejects an unsafe storage destination: %j",
    async (options) => {
      const dir = await fixture()
      const remote = storage(options)
      try {
        await expect(
          uploadEncryptedBackup(dir, config, remote.aws)
        ).rejects.toThrow()
        expect(remote.objects.size).toBe(0)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
  it.each([{ corrupt: true }, { failPut: true }])(
    "never completes a failed or corrupted upload: %j",
    async (options) => {
      const dir = await fixture()
      const remote = storage(options)
      try {
        await expect(
          uploadEncryptedBackup(dir, config, remote.aws)
        ).rejects.toThrow()
        expect(
          [...remote.objects.keys()].some((key) =>
            key.endsWith("complete.json")
          )
        ).toBe(false)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }
  )
})
