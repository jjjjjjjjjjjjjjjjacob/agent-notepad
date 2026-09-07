import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"

export type BackupStorage = {
  bucket: string
  accountId: string
  region: string
}
export type AwsCommand = (args: string[]) => Promise<Record<string, unknown>>

export function backupStorage(
  env: Record<string, string | undefined>
): BackupStorage {
  const bucket = env.BACKUP_S3_BUCKET ?? ""
  const accountId = env.BACKUP_AWS_ACCOUNT_ID ?? ""
  const region = env.AWS_REGION ?? ""
  if (
    !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket) ||
    !/^\d{12}$/.test(accountId) ||
    !/^(us|eu|ap|ca|sa|me|af|il|mx)-[a-z]+-\d+$/.test(region)
  )
    throw new Error(
      "Configure BACKUP_S3_BUCKET, BACKUP_AWS_ACCOUNT_ID, and AWS_REGION."
    )
  return { bucket, accountId, region }
}

async function sha256(file: string) {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest("base64")
}

export async function uploadEncryptedBackup(
  directory: string,
  config: BackupStorage,
  aws: AwsCommand
) {
  const run = basename(directory)
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(run) ||
    !(await lstat(directory)).isDirectory()
  )
    throw new Error("Invalid backup directory.")
  const names = (await readdir(directory)).sort()
  const expected = names.includes("snapshot.zip.enc")
    ? [
        "ledger.enc",
        "ledger.enc.tag",
        "snapshot.zip.enc",
        "snapshot.zip.enc.tag",
      ]
    : ["ledger.enc", "ledger.enc.tag"]
  if (JSON.stringify(names) !== JSON.stringify(expected))
    throw new Error(
      "Backup must contain only complete encrypted snapshot/ledger pairs."
    )
  const objects: { name: string; size: number; sha256: string }[] = []
  for (const name of names) {
    const file = join(directory, name)
    const info = await lstat(file)
    if (!info.isFile() || info.size > 5 * 1024 ** 3)
      throw new Error(
        "Backup uploads require regular files no larger than 5 GiB."
      )
    if (name.endsWith(".tag")) {
      if (info.size !== 16)
        throw new Error("Invalid backup authentication tag.")
    } else {
      const handle = await open(file, "r")
      try {
        const header = Buffer.alloc(16)
        const { bytesRead } = await handle.read(header, 0, 16, 0)
        if (bytesRead !== 16 || header.subarray(0, 4).toString() !== "ANB1")
          throw new Error("Refusing a plaintext or unrecognized backup.")
      } finally {
        await handle.close()
      }
    }
    objects.push({ name, size: info.size, sha256: await sha256(file) })
  }

  const identity = await aws(["sts", "get-caller-identity"])
  if (identity.Account !== config.accountId)
    throw new Error("Unexpected AWS account.")
  const bucket = [
    "--bucket",
    config.bucket,
    "--expected-bucket-owner",
    config.accountId,
  ]
  const access = (await aws(["s3api", "get-public-access-block", ...bucket]))
    .PublicAccessBlockConfiguration as Record<string, unknown> | undefined
  if (
    ![
      "BlockPublicAcls",
      "IgnorePublicAcls",
      "BlockPublicPolicy",
      "RestrictPublicBuckets",
    ].every((key) => access?.[key] === true)
  )
    throw new Error("All S3 public-access blocks must be enabled.")
  const policy = (await aws(["s3api", "get-bucket-policy-status", ...bucket]))
    .PolicyStatus as Record<string, unknown> | undefined
  if (policy?.IsPublic !== false)
    throw new Error("Backup bucket must have a nonpublic policy.")

  const verifyDirectory = await mkdtemp(
    join(tmpdir(), "agent-notepad-s3-verify-")
  )
  async function upload(name: string, file: string, checksum: string) {
    const key = `production/${run}/${name}`
    await aws([
      "s3api",
      "put-object",
      ...bucket,
      "--key",
      key,
      "--body",
      file,
      "--if-none-match",
      "*",
      "--server-side-encryption",
      "AES256",
      "--checksum-algorithm",
      "SHA256",
      "--checksum-sha256",
      checksum,
    ])
    const downloaded = join(verifyDirectory, name)
    await aws(["s3api", "get-object", ...bucket, "--key", key, downloaded])
    if ((await sha256(downloaded)) !== checksum)
      throw new Error("Uploaded backup verification failed.")
  }
  try {
    for (const object of objects)
      await upload(object.name, join(directory, object.name), object.sha256)
    // A restore may use a run only after every object verified and this marker exists.
    const manifest = join(verifyDirectory, "manifest-source.json")
    await writeFile(manifest, JSON.stringify({ version: 1, run, objects }), {
      mode: 0o600,
      flag: "wx",
    })
    await upload("complete.json", manifest, await sha256(manifest))
    return {
      bucket: config.bucket,
      prefix: `production/${run}/`,
      files: objects.length,
      verified: true,
    }
  } finally {
    await rm(verifyDirectory, { recursive: true, force: true })
  }
}
