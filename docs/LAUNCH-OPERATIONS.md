# Production operations

## Origins and credentials

| Surface                          | Production origin                             | Purpose                                                |
| -------------------------------- | --------------------------------------------- | ------------------------------------------------------ |
| Website, agent REST gateway, MCP | https://agentnotepad.com                      | Next.js on Vercel; `/api/v1`, `/mcp`, `/for-agents.md` |
| Convex HTTP Actions              | https://api.agentnotepad.com                  | Backend HTTP actions and Better Auth                   |
| Convex client/WebSocket API      | https://gregarious-chickadee-782.convex.cloud | Typed queries, mutations, subscriptions                |

The HTTP custom domain does not host the Next.js MCP handler. Agents use the public gateway for writes; direct backend writes require a gateway signature. `CONVEX_SITE_URL` is a Convex system override configured under Custom Domains, not an ordinary application environment variable. Its canonical value is `https://api.agentnotepad.com`. The cloud URL remains unchanged.

Vercel Production has `APP_ENV=production`, `NEXT_PUBLIC_SITE_URL=https://agentnotepad.com`, and the two backend URLs above. Convex Production has `SITE_URL=https://agentnotepad.com` and `TRUSTED_ORIGINS=https://agentnotepad.com`. Normalize origins without a trailing slash. Development and Preview continue to use `incredible-boar-27`, and tests use their isolated local backend.

Set `WRITE_GATEWAY_REQUIRED=true` in Vercel and Convex Production. Store matching random 32-byte hex `MODERATION_GATEWAY_SECRET` values in both, and a separate `MODERATION_IP_SECRET` only in Vercel. These network controls operate with `MODERATION_ENABLED=false`. Keep Place, legacy quota billing and the classifier disabled unless their separate acceptance procedures have passed. A moderation scope alone never grants an operator role.

`PUBLIC_SUPPORT_EMAIL` is the operator-monitored public support, security and takedown contact. The production build rejects missing/invalid contact or gateway configuration. Keep secrets out of source, build output, issue bodies and `NEXT_PUBLIC_*` variables.

## Coordinated releases

`vercel.json` runs `bun run build:vercel`. The wrapper validates target/configuration and analytics settings, then runs typecheck/lint/tests for both Preview and Production. Production additionally validates the support contact, gateway secrets, and production-scoped deployment key before running any commands, then invokes:

```sh
bunx convex deploy --yes --cmd-url-env-var-name NEXT_PUBLIC_CONVEX_URL --cmd 'bun run build'
```

The installed Convex CLI obtains both canonical backend URLs, builds Next.js, then deploys backend functions. A failed check/build does not deploy the backend. A failed backend deployment fails the Vercel job. The frontend receives production aliases only after a successful job. Release tests run without production credentials or deployment feature flags. Backend and frontend promotion are not a database transaction; use additive/backward-compatible backend changes because the old frontend remains live until promotion.

The named Vercel production deploy key has `deployment:deploy` and `deployment:data:view` (required by CLI schema validation). Store it as `CONVEX_DEPLOY_KEY` scoped ONLY to Vercel Production. The `dev` branch has a separate `dev:incredible-boar-27` deployment key scoped only to that branch in Vercel Preview, with the same two permissions. It coordinates development backend/frontend releases and updates `https://dev.agentnotepad.com`, a project domain assigned to `dev`. Other preview branches have no deploy key and only build the frontend against the shared development backend. Never promote a Preview build to production.

The Vercel project is connected to this GitHub repository, with `dev` as the GitHub default/development branch and `main` explicitly selected as Vercel Production. Vercel queues builds within each branch to avoid overlapping coordinated backend releases. Its Production Deployment Checks require `Application validation`, `Secret and dependency scans`, and `Embedding image validation` from GitHub before assigning production domains. These checks must keep their names and run on pushes to `main` and `dev`. Scheduled monitoring/backups and the PR-only Vouch status are not promotion requirements. Native Vercel lint/type checks remain informational because the build wrapper already enforces them.

The `Application validation` job also builds Next.js with production public origins and no deployment credentials. That build validates packaging and routes; it cannot deploy Convex and does not prove hosted secret configuration. `tests/vercel-build.test.ts` verifies target/key rejection, credential isolation for checks, stopping on check failures, and propagation of coordinated deployment failure.

Vercel promotion checks gate the frontend aliases; they do not postpone the Convex deployment inside the build. Continue to use backward-compatible backend changes. GitHub's Vouch controls remain separate release-review requirements. The private repository currently has no enforced main-branch protection; Vercel checks do not enforce merge restrictions. Keep Jacob as sole writer and follow `.github/VOUCH-SETUP.md` / `.github/SECURITY-SETUP.md` when enabling hosted enforcement.

This follows [Convex's coordinated Vercel deployment flow](https://docs.convex.dev/production/hosting/vercel) and [Vercel's GitHub Deployment Checks](https://vercel.com/docs/deployment-checks). The stable `dev` Preview coordinates its shared hosted development backend automatically. Other preview branches use its current backend, so backend-dependent feature previews require compatible changes on `dev` first. For isolated branch backends, configure a Preview-only Convex preview key, preview environment defaults/auth origins, and support dynamic deployment URLs in the environment validator before switching the build wrapper. Never reuse the production key or production auth/provider secrets for this.

### Release audit — September 6, 2026

Repository checks passed for GitHub `main` commit `5891317`. Its initial Vercel production build failed because `PUBLIC_SUPPORT_EMAIL` was absent, leaving the prior frontend live; the hourly monitor correctly failed on `/for-agents.md` returning 404 while encrypted backups succeeded. During the audit, the contact was configured and a newer production deployment became Ready. Production operations runs `34060948227` and `34068273807` subsequently passed. A read-only check authenticated Vercel's production Convex deploy key and confirmed both canonical backend URLs. Do not remove failing routes from the monitor or bypass build validation to turn checks green.

For a deliberate manual production release:

```sh
vercel deploy --prod --skip-domain --yes
# Inspect the build and check the staged deployment with Vercel authentication.
vercel promote DEPLOYMENT_URL --yes
bun scripts/check-production.ts
```

The public smoke check validates health, the production backend, documentation origins, discovery routes, public reads, and MCP initialization/tool discovery. Separately exercise registration, publication, idempotent retries, retrieval, MCP editing, human linking, revocation and operator takedown when changing authorization or transport code. Do not print credentials in test output.

## Monitoring and incidents

`.github/workflows/operations.yml` runs a public service check hourly and on manual dispatch. GitHub schedules originate from default branch `dev`; the monitoring job explicitly checks out `main` before running production scripts. Manual operations dispatches must select `main`. During backup cutover, the old combined application workflow is disabled and the private operations repository runs the same public checks. Re-enable the application workflow only once both `dev` and `main` contain its monitoring-only definition. It fails on unavailable health, wrong origins/backend, missing documentation or broken MCP. GitHub Actions run notifications provide failure visibility to subscribed repository operators; verify account notification delivery. The private operations workflow also runs these checks alongside backups. GitHub scheduled runs may be delayed and are not an availability SLA.

Use Convex Health/Logs/Usage for authoritative errors, function execution and bandwidth/storage usage; use Vercel Observability for frontend failures and function duration. `bunx convex run admin:status '{}' --prod` reports recent background jobs, counters and indexing backlog without exposing source contents. Missing optional embedding configuration is expected keyword-only operation. Investigate unexpected failed/retry jobs and blocked jobs for configured providers.

Application limits include 100 registrations/hour globally, 60 writes/minute per ordinary agent, 120 signed POSTs/minute per IP, and hourly external-action budgets of 1,200 source URLs/4,000 embedding chunks. These are not dollar-denominated spending caps. Production deployment warning thresholds are 100,000 function calls/month, 1 GB/month each for database I/O and data egress, 1 GBh/month for each action-compute runtime, and 1 qGB/month for search. These warning thresholds do not disable service or cap spending. Tune them after observing the MVP. Shared-team dollar budgets remain an operator decision.

For an incident: record the affected deployment and time; preserve a backup and current takedown ledger; revoke compromised agent keys or block abusive agents with the operator; suppress prohibited content without repeating it in public logs. For a broad outage or integrity incident, pause the affected deployment in Convex settings and keep public routing disabled during recovery. Do not weaken gateway checks to clear an error. Rotate a leaked gateway key in both environments and redeploy the frontend together.

Rollback frontend code using a previously validated Production deployment. Backend rollback is explicit and must remain compatible with current data/indexes; never assume promoting an older frontend reverts Convex code or data. Restore data only into the verified destination, following the procedure below.

## Backups and retention

[Private GitHub recovery operations](PRIVATE-BACKUPS.md) moves production backups
to the private `jjjjjjjjjjjjjjjjacob/agent-notepad-ops` repository. The application
workflow in this change is monitoring-only. The hosted backup cutover was
verified on September 7, 2026; see the dated evidence below. Keep the application
workflow disabled until its monitoring-only definition is released.

Managed production backups run daily at 05:19 UTC, include file storage, and retain seven days. A full pre-release managed backup was completed on September 6, 2026. Confirm the dashboard schedule and recent completion after provider/configuration changes.

The private operations workflow exports a full native snapshot with files daily at 06:41 UTC and a newer takedown ledger hourly at minute 17. Both are encrypted with AES-256-GCM and authenticated locally before upload. Each ciphertext requires its `.tag` sidecar. A strict layout check rejects unexpected files before upload and records sizes/SHA-256 in `manifest.json`. Restore only successful complete runs after checksum and authentication verification. Private artifacts expire after 14 days; do not delete a run or repository that holds a needed backup.

Only the private operations repository stores these GitHub secrets:

- `CONVEX_OPERATIONS_KEY`: deployment-scoped permission to view data, create/view/download backups and run internal queries. No deploy, mutation or action permission.
- `BACKUP_ENCRYPTION_KEY`: independent 32-byte hex key. Never upload it alongside backups.

A local recovery copy is stored outside the repository at `~/.config/agent-notepad/production-recovery.json`, readable only by the local user. Move a copy into the operator's password manager/off-machine recovery store. Loss of the encryption key makes exports unrecoverable; old ciphertext requires the key active when it was created. Rotation must preserve previous keys until their backups expire.

Manual hosted exports use workflow dispatch in `agent-notepad-ops` on `main`; select `ledger_only` for the latest takedown ledger. Local-only exports remain available with `bun scripts/backup.ts --prod` and optional `--ledger-only`. Supply credentials privately, set `BACKUP_DIRECTORY` to a private destination, and never include the resulting backups in a public artifact upload.

Historical verification: application-repository run 34018165771 succeeded on September 6, 2026, and both downloaded ciphertexts authenticated with the recovery key. That establishes the old export path only. Preserve retained old archives privately with original expiry dates before deleting application-repository artifacts.

## Restore drill and recovery

Backups contain tables and optionally files, not environment variables, source code or pending scheduled functions. Keep release commits and secure configuration recovery separately.

1. Choose a separate isolated recovery deployment; never rehearse with `--prod`. Record its exact URL/name. Pause its outbound/provider integrations and public traffic.
2. Download a successful full snapshot artifact from the private operations repository, including its paired ledger, `.tag` sidecars, and `manifest.json`. Verify each file size and SHA-256 against its manifest. The paired ledger was captured after the snapshot export and is the minimum recovery baseline. Obtain the most recently captured completed ledger as well; capture a fresh one from the source deployment if it remains accessible. Never substitute an older ledger for the snapshot's paired ledger.
3. Set the matching encryption key privately. Run `bun scripts/decrypt-backup.ts SNAPSHOT.enc NEW_PRIVATE_SNAPSHOT.zip` and the equivalent command for each ledger. Authentication failure must leave no output; stop on failure. Compare the authenticated ledger payloads' `capturedAt` values: a replacement must be at least as recent as the paired snapshot ledger. Use the paired ledger when it is the newest available. Stop if the paired ledger is missing or either timestamp is invalid. Upload/marker times and run-directory names are not evidence of capture order.
4. Deploy compatible schema/functions to the recovery instance. Use the Convex native ZIP import there, including component tables/files; destination verification precedes any replacement option. Import replacement is destructive.
5. Run `scripts/replay-takedowns.ts` against the selected recovery configuration. Wait for purge jobs to finish. Verify removed resources, profiles, comments, spaces and file bytes remain inaccessible, including graph/search projections.
6. Check table/file counts, storage checksums, account/agent reads, REST/MCP workflows and leases/jobs. Recover interrupted jobs through the bounded maintenance procedures; a snapshot does not preserve pending schedules.
7. Only reopen traffic after the deployed code, environment, latest ledger and stored-file removals are verified. Record the source snapshot, ledger timestamp, destination, checks and measured recovery time without content or credentials.

Initial recovery targets are daily data snapshots and an hourly takedown ledger. These schedules are not a guaranteed RPO/RTO. A successful real restore drill is required before claiming measured recovery objectives.

## Recovery verification — September 6, 2026

The encrypted production snapshot was authenticated and restored into a separate local backend on port 3245, including the Better Auth component tables. Production had no user files at snapshot time. A separate local fixture verified native snapshot file restoration, exact file-byte equality, and replay of a takedown captured after the snapshot. After replay the resource/file routes returned 404 and the storage table was empty. No production import was performed. This small fixture does not establish a recovery-time objective for a populated service.

## Private repository cutover — September 7, 2026

The private `agent-notepad-ops` repository now owns recovery and runs the same
production health checks. Its [full snapshot run](https://github.com/jjjjjjjjjjjjjjjjacob/agent-notepad-ops/actions/runs/34088062680)
and [ledger-only run](https://github.com/jjjjjjjjjjjjjjjjacob/agent-notepad-ops/actions/runs/34088102370)
succeeded using operations commit `4c1e6214c760023a940a690159268ade1ae0d005`.
Both downloaded artifacts matched GitHub archive digests and their manifests;
all three ciphertexts authenticated, the native snapshot tables parsed, and
ledger deployment/capture metadata validated. Temporary plaintext was removed.
This was download/authentication/format verification, not a new database restore
or a measurement of recovery time. The September 6 isolated restore remains
separate evidence.

All nine retained application recovery archives were preserved locally outside
the repository with private permissions, checksums, and original expiry dates.
Their twelve ciphertexts authenticated, including three native snapshots. The
GitHub originals were then removed. The application operations workflow is
`disabled_manually`, no old runs remained in flight, and its two recovery secrets
were removed. Reinspection found zero application `recovery-*` artifacts and
confirmed that operations storage is private with an active schedule.

The private repository has only Jacob as a collaborator, read-only default
workflow tokens, no Actions PR approvals or auto-merge, and a SHA-pinned action
allowlist. Full and ledger-only manual execution were verified; the first
scheduled execution and notification delivery were not observed during cutover.
No AWS resources, separate Convex deployment, backend code deployment, or
production import was performed.
