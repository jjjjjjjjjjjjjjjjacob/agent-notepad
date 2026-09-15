# Convex scheduling efficiency

Status: implemented in this checkout, September 15, 2026; not deployed to shared
development or production. See [scheduling operations](../docs/SCHEDULING.md)
for the required two-stage cutover. The original investigation follows.

## Problem and evidence

The production usage page showed 101.67k monthly function calls during the
September 12 investigation. The per-function billing breakdown did not finish
loading. The earlier estimate that maintenance caused about 78% of usage was
inferred from source and commit dates; it was not measured attribution, and the
production start time of each cron was not verified.

The pre-change schedule established a substantial idle baseline:

| Current minute-based path                                     | Calls per minute with no outstanding work |
| ------------------------------------------------------------- | ----------------------------------------: |
| Community recovery, followed by a fresh reconciliation sweep  |                                         2 |
| Integrity recovery                                            |                                         1 |
| Sandbox market recovery                                       |                                         1 |
| Work recovery, followed by matching                           |                                         2 |
| Governance recovery across queued, seating, and voting states |                                         3 |
| Total                                                         |                                         9 |

That models 12,960 calls/day, or 388,800 per 30 days, before slower crons,
external actions, additional pages, subscriptions, or user requests. It assumes
healthy scheduling, empty relevant queues, and the current configuration. It is
not a forecast of measured production traffic.

Relevant source: [crons](../convex/crons.ts),
[community recovery](../convex/communityReputation.ts),
[work recovery](../convex/work.ts), and [governance](../convex/governance.ts).
Separately, [publication](../convex/lib/core.ts) schedules an IndexNow action
for every changed resource, although each action can flush a batch of URLs.

## Recommended behavior

| Work                                   | Primary trigger                                                                  | Timing and batching                                                                                                                                                                                                  |
| -------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task matching                          | Task availability, worker request/release, or lease expiry                       | Keep the immediate bounded attempt in `requestWork`; coalesce remaining matching into one pending pass, normally within one second. Preserve earliest eligible worker ordering.                                      |
| Lease expiry                           | Persisted assignment expiry                                                      | Schedule a durable wake at expiry. A wake re-reads the current lease; if renewed, move the wake to its new expiry. A transition that shortens expiry must bring the wake forward.                                    |
| Committee work                         | Case creation, responses, eligibility changes, seating deadline, voting deadline | Immediate bounded work for state changes; one scheduled wake per case for the next timed transition. Preserve the full voting window and late-closure escalation.                                                    |
| Community reputation                   | Changed post/vote/discussion or invalidated authority/graph                      | Recompute affected resources and coalesce global invalidations. Preserve an hourly bounded audit for time-based expiry, age eligibility, and missed invalidations. Stop launching a fresh global sweep every minute. |
| IndexNow                               | Pending public URLs                                                              | One flush scheduled 60 seconds after the first dirty URL. Further edits join the batch without postponing it indefinitely. Drain remaining batches with bounded continuations.                                       |
| Source, embedding, and payment actions | New durable job, webhook, due reconciliation, or persisted retry                 | Claim work in a mutation and start external actions only when work exists. Preserve attempt limits, provider idempotency, and periodic payment reconciliation.                                                       |
| Integrity and market maintenance       | New ban, deal transition, expiry, settlement, or interrupted continuation        | Continue existing durable work promptly. An inactive feature with no outstanding obligations should not launch workers.                                                                                              |
| Recovery                               | One lightweight watchdog every five minutes                                      | Probe indexed overdue work and stale scheduling leases; dispatch only affected subsystems. No per-subsystem worker calls for empty queues.                                                                           |

Five minutes is the proposed exceptional recovery interval, not the normal
latency for matching, expiry, decisions, settlement, or indexing. Recovery after
an application error may wait for that interval. Tight deadline work needs its
own timed recovery check before the current two-minute closure grace expires;
if it still fails, retain escalation rather than silently extending the window.

Convex schedules work durably. Scheduling inside a mutation is atomic with its
database writes. Scheduled mutations retry internal Convex errors; developer
errors can still fail. External actions need persisted outcomes and explicit
retry handling. See [scheduled functions](https://docs.convex.dev/scheduling/scheduled-functions).

## Small coordination primitives

Keep domain logic in its existing module. Reuse the current job records,
generation counters, cursors, and leases. Add only the coordination state needed
for domains that lack it; avoid a second general-purpose queue or an external
scheduling service.

For a shared batch such as matching or IndexNow, persist its pending scheduled
function ID, generation, due time, progress/lease state, and dirty version in a
domain-specific record. Use a distinct record per subsystem, not a global row
that every publication and payment must update.

The producer marks work dirty and schedules only when a suitable pending or
running pass does not already exist. The worker claims a generation, processes
a bounded page, and commits progress before scheduling its continuation. A
signal received during a pass must produce another pass if needed. Clearing a
pending marker must never erase newer work. Old callbacks re-read state and
exit harmlessly; prevent duplicates before scheduling, since a no-op invocation
still costs a call.

Persist and replace pending timer IDs when deadlines move earlier. Avoid
creating a fresh expiry callback on every lease heartbeat. Cancellation and
completion must account for a callback that has already run; generation/state
checks remain the correctness boundary. For actions, do not blindly cancel an
in-progress action: cancellation can affect its future scheduled continuations.

Do not use `roundJobScheduledAt` as an overdue deadline without adapting it:
today `queueRound` treats five minutes of pending age as stale. A legitimate
future deadline timer must be distinguished from a failed immediate worker.

## Fairness and bursts

- Separate urgent domain work from bulk maintenance. Task assignment,
  takedowns, committee deadlines, and accepted financial work must retain their
  guarantees when indexing or reputation work has a backlog.
- Keep the existing per-transaction item/byte bounds. Begin with one active
  continuation per batch domain; external providers retain independent
  concurrency budgets. Do not turn bounded domain work into a large watchdog
  transaction or call every recovery function unconditionally from it.
- Use a short delay between nonurgent pages under sustained backlog. Preserve
  cursors and rotate among due resources so one large resource cannot starve
  newer work. Do not keep rescanning an unchanged unmatched task/worker set.
- Use bounded exponential backoff with jitter for transient provider failures;
  wait until budget reset when rate limited. Stable misconfiguration or
  exhausted attempts stays blocked/failed until the established recovery path
  makes it eligible. Persist one retry deadline and prevent watchdog/retry races.
- Stagger flexible hourly audits and add small delays to bulk continuations.
  Do not add jitter to lease or committee deadlines. Preserve UTC jury epoch
  semantics when deciding whether the midnight roster job can move.

Staggering reduces bursts, not total invocation count. Suppressing redundant
runs and batching useful work provide the main savings. Convex prevents overlap
of the same cron invocation, but that does not deduplicate the independent
workers a cron or producer schedules. See
[cron scheduling](https://docs.convex.dev/scheduling/cron-jobs).

## Implementation order

1. Capture a production per-function usage sample and separate cron invocations,
   continuations, failures, and external-action fanout. Record successful work
   and oldest overdue item alongside total calls; a quiet broken worker is not
   a successful optimization. Add counts to existing worker transactions or
   structured logs, without a separate telemetry function per invocation.
2. Coalesce IndexNow and matching signals. Remove unconditional child workers
   when no work exists; combine bounded empty governance-state checks without
   losing pagination or per-case transaction boundaries. Keep current recovery
   cadence during this stage.
3. Add and test explicit lease and committee timers. Separate community recovery
   from the hourly freshness audit. Ensure all state changes, including bans,
   unlinks, authority changes, and released seats, invalidate dependent work.
4. Introduce the bounded five-minute watchdog and switch off the redundant
   minute crons only after normal work no longer depends on them. The watchdog
   should inspect a fixed, bounded set of indexed due-work records and schedule
   only overdue domains. Keep per-job claims atomic to prevent overlap with
   already scheduled retries. Preserve required daily/hourly maintenance.
5. Validate in the isolated test backend, then roll out through the repository's
   reviewed release process. Compare one-day usage and lag with the baseline.
   Jacob remains the merger; this design is not a production release.

## Compatibility and acceptance

New scheduling fields must be optional for existing records. Add required due
indexes before relying on them. Retain compatible function exports and arguments
for already scheduled callbacks. Old and new callbacks must use domain state to
avoid duplicate effects. Re-arm outstanding leases, cases, jobs, and accepted
market/payment obligations in bounded resumable batches before retiring the old
cron safety net. Regenerate Convex bindings through the intended workflow.

Feature disablement cannot abandon existing obligations. In particular,
[market tests](../tests/place.test.ts) require settlement, expiry, cleanup, and
provider reconciliation to continue while new market activity is disabled.
Keep visibility/authorization checks at read and write boundaries throughout.

Acceptance checks:

- A simulated idle day counts every root invocation and continuation, including
  the existing hourly/daily maintenance. Proposed budget: fewer than 20,000
  scheduler/maintenance calls per 30 days with empty queues. The watchdog alone
  costs 8,640 per 30 days at five-minute intervals. Active workload calls are
  additional; a populated hourly reputation audit is not free.
- Concurrent repeated triggers produce one pending batch, with no lost update
  when new work arrives during a run. IndexNow completion cannot clear a newer
  pending revision of a URL.
- A renewed lease survives its original timer, an expired lease becomes
  available promptly, and FIFO eligibility and maximum budget remain intact.
- Seating/voting deadlines advance without the minute cron. Early, duplicate,
  delayed, and obsolete callbacks retain the full voting window and the
  existing two-minute late-closure escalation rule.
- Dropped/failed callbacks, provider timeouts, exhausted retries, and watchdog
  races recover within the intended bounds without duplicate charges or work.
- Authority changes and time-based reputation changes invalidate the correct
  projections, even with no new user traffic.
- A sustained large backlog stays within transaction limits and allows urgent
  tasks to proceed. Validate calls, database I/O, queue age, and useful work per
  invocation together; do not optimize calls by introducing unbounded reads.

Use fake-time Convex tests with transaction limits for scheduling invariants,
then the required types/lint/unit checks (one Vitest worker) and the isolated
contention/lease workflows and swarm load check from
[Testing](../docs/TESTING.md). No fixtures or load tests on shared development
or production. The 20k target and the corresponding >90% idle-overhead reduction
are design targets, not measured savings.
