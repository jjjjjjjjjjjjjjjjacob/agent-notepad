# Effect error control flow

The application uses pinned Effect 3.22.1 for expected failures in its HTTP
boundaries, external-service workflows, and user actions. Convex still owns
transactions, subscriptions, durable jobs, and retry admission. Zod still owns
input validation. This describes the working tree, not deployment status.

## Write a fallible workflow

Return an `Effect.Effect<Value, AppError>` from a service helper. Compose it with
`Effect.gen` and return `yield* Effect.fail(appError(code, safeMessage))` for an
expected failure. Use `attempt` or `attemptSync` around one legacy/Convex call,
`external` around an SDK operation, and `fetchEffect` around fetch itself.
Unknown exceptions remain defects; do not convert every exception into a
validation error or a transient outage. Never classify errors by their message.

`AppError` messages are application-authored. Do not copy provider messages,
response bodies, credentials, or arbitrary exception text into them. The shared
error-data decoder validates structured and JSON-encoded Convex errors and strips
unknown fields, including unapproved detail keys. Only plain `code`, `message`,
and approved details (`retryAfterSeconds` and the moderation `caseId`)
cross an application boundary.

Use `runHttp` at an HTTP entrypoint, `runConvex` at an action handler, and
`useEffectAction` for browser actions. `runEffect` exists for thin Promise
compatibility adapters and framework callbacks. Do not execute a new runtime
inside an Effect service to call another Effect service. Do not create detached
fibers in a request or replace Convex scheduling with an in-memory scheduler.

Recover only from the errors for which that workflow has a policy. An Effect
failure is not a JavaScript throw: a `try/catch` surrounding `yield*` does not
handle the error channel. Use Effect matching/catching instead. Retain ordinary
throws in existing Convex database helpers so failed mutations still roll back.

## Responses and recovery

Existing REST data/error envelopes, moderation string-error responses, MCP tool
results, and webhook acknowledgement rules remain compatible. Error statuses:

| Code                        | HTTP status |
| --------------------------- | ----------- |
| VALIDATION                  | 400         |
| UNAUTHORIZED                | 401         |
| FORBIDDEN                   | 403         |
| NOT_FOUND                   | 404         |
| METHOD_NOT_ALLOWED          | 405         |
| CONFLICT                    | 409         |
| PAYLOAD_TOO_LARGE           | 413         |
| RATE_LIMITED                | 429         |
| INTERNAL                    | 500         |
| BAD_GATEWAY                 | 502         |
| NOT_CONFIGURED, UNAVAILABLE | 503         |
| TIMEOUT                     | 504         |

A provider outage does not invalidate a user's credentials. Invalid credentials
remain an authorization failure; missing provider configuration and provider
outages block protected work. Defects produce a generic response and sanitized
source/code/kind diagnostics, never raw exception text. An MCP operation failure
is returned with `isError: true`; protocol failures retain protocol formatting.

Only unavailable services, timeouts, and rate limits qualify as transient.
There is no automatic replay of browser writes or an additional gateway/SDK
retry layer. Indexing jobs retain four attempts and durable backoff. Configuration
failures are blocked; permanent failures and defects are terminal. Permanent
source unavailability is recorded per citation; transient source failures can
retry the source job. Permanent IndexNow rejection leaves a failed notification;
a later content change can queue it again. No stored schema migration is needed;
job completion accepts an optional terminal flag.

Keyword fallback applies to expected failures of the optional semantic service.
It does not hide programming defects or failures of the primary keyword query.
Screening failures never authorize publication. Wallet processing parks confirmed
events that cannot be applied and never repeats their provider call. Analytics
remains best effort with its existing three-attempt budget and consent controls.

## Browser actions

The shared runner handles success/failure callbacks, safe messages, and busy-state
cleanup, including immediate duplicate-submit suppression. Rendering and Convex
query subscriptions continue to use React/Next error boundaries. Better Auth's
route remains framework-owned; its client action results are normalized.

Use `useIdempotentMutation` for a mutation that accepts an idempotency key. It
retains the key and fingerprint in memory after an uncertain failure. Retrying
the same input reuses that key; success, a known definitive rejection, or changed
input starts a new intent. It does not persist sensitive input in browser storage
or guarantee key retention after a reload/unmount. Do not automatically retry
registration, claiming, or other operations that return one-use secrets.

## Included boundaries

The HTTP adapters cover the REST gateway, Convex dispatcher, MCP invocation,
moderation reporting/linking, and Stripe/sandbox webhook entrypoints. Service
workflows cover embeddings and semantic retrieval, source retrieval and indexing,
text/file screening, WorkOS actions, the existing Stripe billing actions,
wallet reconciliation, analytics delivery, and IndexNow.

The browser runner covers the account and agent-account actions, moderation
controls and appeals, wallet management, and integrity operations. Convex query
subscriptions, database helpers, Better Auth's framework route, React rendering,
GPU effects, Style Lab, and unrelated utilities retain their existing models.

## Verification

`effect-errors.test.ts` and `effect-actions.test.ts` exercise the shared boundary
and action contracts. RAG, REST/MCP, source-fetch, WorkOS, billing, moderation,
wallet, and analytics tests protect the migrated integrations and existing
security rules. Run `bun run check`, `bun run build`, and the relevant isolated
Playwright workflows before release. No deployment is part of this migration.
