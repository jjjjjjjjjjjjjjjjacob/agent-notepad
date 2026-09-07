# Private GitHub recovery operations

Production recovery belongs in the private
[jjjjjjjjjjjjjjjjacob/agent-notepad-ops](https://github.com/jjjjjjjjjjjjjjjjacob/agent-notepad-ops)
repository. The application source and ordinary sanitized CI artifacts may be
public. Keep the operations repository private permanently; its artifact access
follows repository access. No AWS or separate Convex storage project is needed.

## Verified status — September 7, 2026

The private repository is active. Full run `34088062680` and ledger-only run
`34088102370` succeeded and their downloaded artifacts were authenticated. All
nine old application recovery archives were preserved privately and verified
before removal from GitHub. The old application workflow is disabled, no old
runs remained active, and the application repository has no recovery artifacts
or recovery secrets. See [the cutover evidence](LAUNCH-OPERATIONS.md#private-repository-cutover--september-7-2026).

The steps below remain the procedure for future migrations or re-verification;
they do not require repeating this completed cutover.

## Design

The operations repository contains reviewed copies of the small export, crypto,
decryption, and health-check tools, plus a pinned Convex CLI dependency. It does
not clone contributed application code or need a cross-repository access token.
Updates to those copies are explicit reviewed changes with source provenance.

The private workflow keeps the existing schedules: a full native Convex snapshot
with file storage daily at 06:41 UTC, and a newer takedown ledger hourly at minute 17. Only the private repository's `main` branch may run production jobs, and a
fresh GitHub API check verifies repository privacy before export. GitHub
schedules may be delayed; they are not a guaranteed recovery-point objective.

Both payloads use AES-256-GCM with their `.tag` sidecars. The exporter verifies
authentication locally before success. A strict pre-upload check rejects
plaintext, symlinks, missing sidecars, and unexpected files. `manifest.json`
records generated paths, sizes, and SHA-256 checksums. Only successful, complete
runs are recovery candidates. Artifacts have 14-day retention; deleting a run or
the repository can remove them earlier. This is not immutable backup storage.

Only `agent-notepad-ops` receives `CONVEX_OPERATIONS_KEY` and
`BACKUP_ENCRYPTION_KEY` as Actions secrets. The former remains restricted to
production data reads, exports, and internal queries, without deploy/mutation/
action permission. The encryption key is never included in an artifact. Keep
its independent recovery copy and previous keys until corresponding backups
expire. Keep managed Convex backups enabled.

## Cutover and verification

1. Create and verify the private operations repository. Keep default Actions
   permissions read-only, disable Actions PR approvals and auto-merge, and require
   SHA-pinned actions. Preserve Jacob as the sole collaborator/merger.
2. Configure its two existing recovery secrets privately. Run full and
   ledger-only manual jobs, checking the target deployment and private artifact
   retention. Download both artifacts; verify their checksums and authenticate
   all encrypted payloads with the matching recovery key. Validate the native
   snapshot structure and ledger capture metadata without logging user data.
3. Disable the old application operations workflow only after the private jobs
   and health monitor succeed. Preserve every retained old recovery archive
   outside the application repository with checksums and original expiry dates;
   verify those copies before removing the GitHub originals. Recheck for any
   in-flight old run that could produce another artifact.
4. Remove the application's two backup secrets. Remove its backup job through
   normal review; the application workflow in this change is monitoring-only.
   Jacob merges/releases the source change. Until then, leave the old application
   workflow disabled; the private operations repository also runs health checks.
5. Before public visibility, verify the operations repository is still private,
   its schedule is active, recent backup runs succeed, no `recovery-*` artifacts
   remain in the application repository, and the old job cannot upload more.
   Verify operator failure notifications and retain off-machine key recovery.

Migrated historical archives may remain in the operator's private local recovery
archive with their original expiry dates recorded; they are not added to Git
history or the public repository. Remove those local copies when their recorded
retention expires. Record the preservation location privately. Fresh daily and
hourly artifacts are stored in the private operations repository.

## Recovery

Download a successful full run from `agent-notepad-ops`. Verify each encrypted
file's size and SHA-256 against `manifest.json`, using its
`scripts/verify-backup.ts DIRECTORY --existing`. Authenticate the snapshot and
ledger with `scripts/decrypt-backup.ts`, keeping plaintext in a private temporary
directory and removing it after inspection or recovery.

Start with the ledger paired with the full snapshot; it was captured after the
snapshot export. Replace it only with an authenticated ledger whose `capturedAt`
is at least as recent. Stop if the paired ledger is missing or either capture
timestamp is invalid. Marker/upload times do not establish capture order.
Follow the [isolated restore and takedown replay procedure](LAUNCH-OPERATIONS.md#restore-drill-and-recovery).

Backups include restricted records, even when some content is CC BY-SA. They
are not public dataset exports. Encryption protects content; private artifact
access adds a separate boundary and limits distribution of historical copies.

Reference: [GitHub artifact access](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).
