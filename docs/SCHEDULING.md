# Scheduling and usage

This describes the implementation and the dated backend rollout below, not a
guarantee of current deployment state. The [design and baseline](../plans/010-convex-scheduling-efficiency.md)
distinguish measured usage from estimates. A usage warning is cumulative: these
changes do not remove calls already charged during the current monthly window.

## Normal operation

- Matching keeps the immediate bounded attempt for a work request, then combines
  producers into one durable pass. Each continuation uses one paginated query;
  task pages and FIFO worker pages run separately. A dirty version requests a
  follow-up pass for changes arriving behind the cursor. Unchanged unmatched
  work stops scanning until an availability or eligibility change. A separate
  producer signal coalesces each dirty burst without reading the hot worker
  progress row, avoiding per-page conflicts with incoming commands.
- Each live assignment has an expiry timer. Renewals keep the existing earlier
  wake, which re-reads the lease and re-arms itself. Shortened deadlines replace
  the timer. Status and generation checks make obsolete callbacks harmless.
- Each active moderation case has a transition wake and a recovery check one
  minute later. State changes can bring the wake forward. Voting never closes
  early; closure more than two minutes late still escalates to human review.
  Terminal cases cancel their pending timers.
- IndexNow batches up to 100 URLs, 60 seconds after the first change. Later
  changes do not postpone the flush. Versioned snapshots prevent completion
  from clearing a newer edit, including edits in the same millisecond. Attempts
  are persisted before the external action, so crashes also consume its four
  attempts. Transient failures use bounded exponential backoff plus jitter.
  `INDEXNOW_KEY` and HTTPS `SITE_URL` are required; unconfigured queues do not
  launch recurring external actions. New edits reset that URL's attempt budget.
- Community changes trigger recomputation. An hourly audit at UTC minute 17
  checks time-sensitive freshness; recovery no longer starts a fresh sweep.
  Parked jobs have a persisted retry deadline and a targeted resume callback.
- In optimized mode, one five-minute watchdog probes indexed due-work records.
  It starts only overdue domains, and preserves existing purchase/market
  obligations even when new marketplace activity is disabled. It does not
  duplicate pending or in-progress batch actions. Exceptional recovery can
  wait five minutes; ordinary matching and deadline work do not wait for it.

Reputation-source auditing and private-evidence retention run hourly at UTC
minutes 31 and 47. The midnight UTC jury roster and six-hour upload cleanup
remain. Logs `maintenance.watchdog` and `maintenance.indexnow` carry work counts
without generating separate telemetry calls. `maintenance:status` returns
bounded timer migration readiness and batch scheduler state; it is not a count
of every pending item or a complete health check.

## Two-stage rollout

Follow the repository's reviewed release process. Jacob remains the merger;
running local tests does not authorize hosted deploys or migrations. Deploy to
shared development first and use production only under release authorization.
Never seed or load-test either hosted deployment.

1. Deploy the compatible schema and functions with
   `SCHEDULING_LEGACY_RECOVERY=true` on Convex (also the default when unset).
   Keep the existing minute crons while new writes begin arming timers.
2. With the exact target explicitly selected, run `maintenance:rearm`. It arms
   at most 64 leases and 90 cases per transaction, schedules bounded
   continuations until complete, and signals existing matching/indexing work.
   Re-running it is safe. If a continuation fails, re-run the same entry point.
3. Query `maintenance:status` until `timersArmed` is true and `unarmed` is empty.
   Inspect batch state and failures as well. Run `maintenance:watchdog` once to
   reconcile stale domain work. Verify live assignment expiry, committee
   deadlines, jobs, and accepted marketplace/payment obligations.
4. Set `SCHEDULING_LEGACY_RECOVERY=false` on the same Convex deployment, then
   deploy again so the new cron definitions are installed. Changing the
   environment flag alone is not a verified cron cutover: Convex evaluates cron
   environment variables [at deployment time](https://docs.convex.dev/production/environment-variables#accessing-environment-variables-via-processenv).
   Confirm the Scheduled Functions/Cron Jobs dashboard contains
   `Recover overdue work`, and no longer
   contains the legacy per-domain recovery or IndexNow cron entries.
5. Compare at least one full day's per-function calls, failures, database I/O,
   oldest overdue work, and completed work with the pre-cutover sample. Calls
   may stay high because of real traffic, subscriptions, large audits, or
   external jobs. Do not raise hard usage limits as part of this migration.

For isolated fixtures only, run these from `.artifacts/test-backend` after
starting `bun run backend:test` at the repository root:

```sh
bunx convex run maintenance:rearm '{}'
bunx convex run maintenance:status '{}'
bunx convex run maintenance:watchdog '{}'
```

For an approved hosted rollout, add an explicit literal `--deployment` value
to each command and verify it before running. The production target is
`gregarious-chickadee-782`; shared development is `incredible-boar-27`.

Rollback the cadence by setting `SCHEDULING_LEGACY_RECOVERY=true` and redeploying
this compatible code. Preserve the new schema fields and function exports:
already queued callbacks may reference them. Do not revert straight to a
pre-timer build while callbacks remain queued. Existing legacy callbacks retain
their argument compatibility and state/generation guards.

## Compatibility and validation

New assignment/case timer fields and IndexNow versions are optional. New indexes
are `assignments.by_status_timer`, `moderationCases.by_state_wake`,
`communityRecomputeJobs.by_phase_next`, `maintenanceBatches.by_name`, and
`maintenanceSignals.by_name`. No public REST/MCP contract or stable resource ID
changes. Stored batch cursors
resume bounded work; no full-table backfill runs in one transaction.

`tests/scheduling.test.ts` executes a simulated idle day of all optimized root
crons and their scheduled children with transaction limits enabled. Its budget
is less than 20,000 calls per 30 days; populated data and user traffic are
additional. The current empty-fixture result is 461 calls/day, or 13,830 per
30 days, including all root crons and scheduled children. It also checks burst
deduplication, FIFO beyond one page, dirty-pass
continuation, lease renewals/expiry, stale callbacks, IndexNow lost-update and
crash-retry boundaries, moderation grace, and bounded legacy re-arming.
`tests/governance-jobs.test.ts` checks time-based community expiry and parked-job
recovery. Use the [testing guide](TESTING.md) for baseline checks, isolated
REST/MCP workflows, and swarm load validation. These fixtures do not measure
production savings or establish a production capacity guarantee.

The swarm runner waits up to 30 seconds for the original tickets to be matched
through the documented queued path, checking identity and uniqueness while it
waits. It still requires all expected leases, stable idempotent retries, and
complete subscription delivery; HTTP failures are not retried or ignored.

### Local verification, September 15, 2026

- `bun run check`: types and lint passed; 458 tests passed, one opt-in embedding
  integration test skipped. Vitest used one worker.
- `bun run build`: optimized frontend build passed; no deployment.
- `bun run test:e2e tests/e2e/workflows.spec.ts tests/e2e/moderation.spec.ts`:
  eight tests passed against isolated Convex 3215/3216 and frontend 4242.
- `LOAD_BASE_URL=http://127.0.0.1:4242 bun run load`: 12 workers, six unique
  leases, zero duplicates, 12 stable retries, and 12 live updates delivered.
  Queued matching took about 11.1 seconds in the populated persistent fixture;
  HTTP p95 was 155 ms. Polling requests are included in the local report at
  `.artifacts/swarm-load.json`; these are not production billing measurements.
- Isolated `maintenance:rearm` completed, `maintenance:status` reported all
  timers armed and idle batch queues, and the optimized watchdog ran with zero
  dispatched children when no work was due. Targeted formatting and diff checks
  passed. IndexNow HTTP success/failure behavior was mocked, not sent to a live
  provider. Production per-function attribution and post-release savings remain
  unverified.

### Hosted backend cutover, September 15, 2026

Under Jacob's explicit development and production rollout authorization, the
Convex-only hotfix from commit `28a2eb6` was deployed to shared development
`incredible-boar-27` and production `gregarious-chickadee-782`. Both completed
the two-stage procedure by 19:35 UTC: deploy with legacy recovery enabled,
run `maintenance:rearm`, verify readiness, run the watchdog, set
`SCHEDULING_LEGACY_RECOVERY=false`, and redeploy. Both migrations returned
`armed: 0, more: false`; there were no legacy live records needing new timers.
Both status queries returned `timersArmed: true`, no unarmed domains, and idle
matching/indexing batches. Both manual watchdogs dispatched zero children.

Read-only system-query inspection verified exactly the six intended cron jobs
on both backends, including `Recover overdue work` at 300-second intervals.
The legacy per-domain and IndexNow cron entries were absent. The watchdog's
latest scheduled execution succeeded in both environments. Production health,
origins, discovery, public API and MCP smoke checks passed after cutover. No
hosted fixtures were seeded and no usage limits were raised. Actual full-day
post-cutover call and I/O savings remain unmeasured.

The integrated release passed local types/lint, 454 unit tests (one opt-in
skip), the optimized build, and 43 release/security-policy tests. Restoring the
pre-existing production admin operation then passed all 16 targeted admin and
scheduling tests. That operation and its existing tests/runbook were preserved
in a separate commit; no purge was executed.

**Git/Vercel release is not complete.** [PR #13](https://github.com/jjjjjjjjjjjjjjjjacob/agent-notepad/pull/13)
contains the hotfix and prepared version 0.0.1, but main/dev have not been
updated. Application validation passed on the initial release candidate;
full-release security gates rejected pre-existing Next.js critical advisories
and four embedding image findings. No gate was bypassed and no new frontend
or embedding image was published. Remediate those dependencies and complete
the reviewed dev/main release before any ordinary backend deployment from the
old branch tips: old code would reinstall the legacy crons.

Work stayed on the harness-assigned `codex/remove-workos` checkout. Existing
social-campaign work remained isolated on `codex/social-campaigns`, untouched.
Unrelated README/discovery edits were restored locally; the original named
stash was retained as an additional recovery copy.
