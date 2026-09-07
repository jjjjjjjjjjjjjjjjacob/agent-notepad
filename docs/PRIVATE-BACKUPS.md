# Private S3 recovery storage

This is the prepared replacement for GitHub recovery artifacts. It is not active
until the AWS stack, repository variables, and workflow release are verified.
Do not make the repository public or remove existing backups during this setup.

The existing export still encrypts the native Convex snapshot and takedown ledger
with AES-256-GCM and verifies decryption locally. `scripts/backup-to-s3.ts` uploads
only recognized ciphertext/tag pairs, rejects the wrong AWS account or a bucket
without all public-access blocks and a nonpublic policy, and downloads every
object to verify its SHA-256. It publishes `complete.json` last. A missing marker
means the run is incomplete and must not be used for restoration.

The uploader uses AWS CLI v2, explicit AWS HTTPS endpoints, three provider retry
attempts, and bounded command timeouts. It supports standard commercial AWS
regions and single files up to 5 GiB. Larger exports need a separately reviewed
multipart implementation. There is no fallback to GitHub artifacts.

## Provision and review

1. Choose the AWS account and region. S3 storage and requests are billed to that
   account. Review the change set before creating resources.
2. Identify the account's existing GitHub OIDC provider. If absent, configure
   `https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`
   through IAM. Do not create permanent AWS access keys for the workflow.
3. Query the actual repository subject configuration; use its exact
   `sub_claim_prefix`, not a guessed owner/repository string:

   ```sh
   gh api repos/jjjjjjjjjjjjjjjjacob/agent-notepad/actions/oidc/customization/sub
   ```

4. Create a CloudFormation change set from
   [infra/backup-storage.yaml](../infra/backup-storage.yaml), supplying the OIDC
   provider ARN and verified subject prefix. Review and execute it in the chosen
   account/region. The stack creates a private bucket with public-access blocks,
   bucket-owner enforcement, encryption at rest, TLS-only access, 14-day expiry,
   and a role limited to this repository's `main`/`dev` OIDC subjects. IAM can
   therefore trust scheduled runs from default branch `dev` and manual runs from
   `main`. The scripts still explicitly check out `main` for production work.
5. Preserve the stack outputs as these GitHub Actions **variables**:
   `BACKUP_S3_BUCKET`, `BACKUP_AWS_ROLE_ARN`, `BACKUP_AWS_ACCOUNT_ID`, and
   `BACKUP_AWS_REGION`. Retain existing **secrets** `CONVEX_OPERATIONS_KEY` and
   `BACKUP_ENCRYPTION_KEY`. Keep the encryption key's independent recovery copy.

The role can inspect the bucket's privacy status and create/read objects under
`production/`; it cannot delete objects, change policies, or administer AWS.
Conditional writes prevent overwriting existing keys. The bucket is retained
if the CloudFormation stack is deleted. Retention is an S3 lifecycle rule;
expiry eligibility and physical deletion are asynchronous. Partial runs also
expire. This is not immutable Object Lock storage or protection against an AWS
account administrator. Never promise otherwise.

## Cut over without losing recovery coverage

1. With the new storage configured, run a **full** `bun scripts/backup-to-s3.ts`
   from this reviewed checkout using the existing production recovery credentials
   privately and the selected AWS identity. This exports production but does not
   modify production data. Run it with `--ledger-only` as well.
2. Using an operator recovery identity, download a completed run from S3. Verify
   each object's size and SHA-256 against `complete.json`, then authenticate both
   ciphertexts with their `.tag` files and the matching recovery key using
   `scripts/decrypt-backup.ts`. Start recovery with the ledger paired with the
   full snapshot; replace it only with an authenticated ledger whose `capturedAt`
   is at least as recent. Stop if the paired ledger is missing or either capture
   timestamp is invalid. Marker/upload time is not capture time. Preserve
   decryption output in a private temporary directory; remove it after inspection. Repeat the isolated restore drill in
   [production operations](LAUNCH-OPERATIONS.md#restore-drill-and-recovery).
3. Jacob merges the reviewed workflow and scripts through `dev` and releases
   them to `main`. Both must contain the change because scheduled workflow
   definitions come from default branch `dev`, while production scripts are
   checked out from `main`. Until that release, the old artifact job is still
   active. Do not describe a successful local upload as a completed cutover.
4. Verify full and ledger-only **GitHub** runs against S3, their OIDC identity,
   completion markers, schedule, and failure notifications. Confirm no new
   `recovery-*` Actions artifacts are created. Keep managed Convex backups on.
5. Preserve needed old recovery exports in private storage with their original
   keys and retention obligations, then delete the old GitHub recovery artifacts.
   Do not delete the only usable backup. Only after this verification and cleanup
   should the source repository become public.

Use new unique run directories when retrying failed uploads; never overwrite a
completed run. Recovery exports include restricted records even when some public
content is CC BY-SA. They are not public data releases.

References: [AWS conditional writes](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html),
[GitHub OIDC with AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).
