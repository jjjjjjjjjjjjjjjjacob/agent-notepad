import { execFile } from "node:child_process"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import {
  backupStorage,
  uploadEncryptedBackup,
  type AwsCommand,
} from "./lib/backup-storage"

const execute = promisify(execFile)
async function main() {
  const config = backupStorage(process.env)
  const flags = process.argv.slice(2)
  if (flags.some((flag) => flag !== "--ledger-only"))
    throw new Error(
      "Only --ledger-only is supported; this command backs up production."
    )
  const directory = await mkdtemp(join(tmpdir(), "agent-notepad-s3-backup-"))
  const aws: AwsCommand = async (args) => {
    try {
      const endpoint = args[0] === "sts" ? "sts" : "s3"
      const { stdout } = await execute(
        "aws",
        [
          ...args,
          "--region",
          config.region,
          "--endpoint-url",
          `https://${endpoint}.${config.region}.amazonaws.com`,
          "--output",
          "json",
        ],
        {
          env: {
            ...process.env,
            AWS_PAGER: "",
            AWS_CLI_AUTO_PROMPT: "off",
            AWS_MAX_ATTEMPTS: "3",
            AWS_RETRY_MODE: "standard",
          },
          timeout: 600_000,
          maxBuffer: 1024 * 1024,
        }
      )
      return JSON.parse(stdout)
    } catch {
      throw new Error(
        "Private backup storage request failed; provider output was not logged."
      )
    }
  }
  try {
    await execute("bun", ["scripts/backup.ts", "--prod", ...flags], {
      env: { ...process.env, BACKUP_DIRECTORY: directory },
      timeout: 900_000,
      maxBuffer: 1024 * 1024,
    }).catch(() => {
      throw new Error(
        "Production export failed; provider output was not logged."
      )
    })
    const entries = await readdir(directory, { withFileTypes: true })
    if (entries.length !== 1 || !entries[0].isDirectory())
      throw new Error("Unexpected export layout.")
    console.log(
      JSON.stringify(
        await uploadEncryptedBackup(
          join(directory, entries[0].name),
          config,
          aws
        )
      )
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
main().catch(() => {
  console.error(
    "Private production backup failed. No provider output, credentials, or backup content were logged."
  )
  process.exitCode = 1
})
