import { backupKey, decryptBackup } from "../lib/backup-crypto"
const [input, output] = process.argv.slice(2)
if (!input || !output)
  throw new Error(
    "Usage: bun scripts/decrypt-backup.ts INPUT.enc NEW_PRIVATE_OUTPUT"
  )
await decryptBackup(input, output, backupKey(process.env.BACKUP_ENCRYPTION_KEY))
console.log(
  "Backup authenticated and decrypted to the requested private output."
)
