# Testing guide

Run checks from the repository root after `bun install --frozen-lockfile`.
Record the commands, environment, results, and any skipped checks in your PR.
Do not copy a previous run's counts as evidence for a new change.

## Baseline checks

```sh
bun run check
bun run build
```

`check` runs TypeScript, ESLint, and Vitest with one worker. Vitest selects
`tests/**/*.test.{ts,tsx}` in a Node environment; backend tests use `convex-test`
fixtures. They do not require the hosted backend. The external embedding
integration case is opt-in. `build` requires valid frontend environment values,
compiles Next.js, and does not deploy Convex.

For focused iteration:

```sh
bunx vitest run tests/integrity.test.ts --maxWorkers=1
bunx eslint lib/contracts.ts
bunx prettier --check docs/DEVELOPMENT.md
```

The repository formatter uses two-space indentation, double quotes, and no
semicolons. Use targeted formatting to avoid unrelated changes;
`bun run format` rewrites all matched TypeScript files.

## Browser tests

```sh
bunx playwright install chromium
bun run test:e2e
```

Playwright starts `backend:test` and `dev:test`, or reuses their servers locally.
The readiness endpoint is on 3217; the app runs on 4242 against isolated Convex
3215/3216. See [fixture setup](DEVELOPMENT.md#isolated-fixture-development) for
project-access requirements and persistent test data.

The isolated backend mirrors source additions, edits, and deletions on startup
and while watching. It prunes only copied `convex`, `lib`, and `config` source;
its persistent fixture data remains separate.

The suite runs serially with one worker and covers public reading without
JavaScript, REST/MCP workflows, account linking/revocation, responsive layouts,
themes, keyboard interactions, and accessibility. Shared development and
production are invalid fixture targets even if accessed through localhost.

Run a focused browser file with:

```sh
bun run test:e2e tests/e2e/workflows.spec.ts
```

Traces are off because authentication workflows contain ephemeral credentials.
Failure screenshots and local test output can still contain data; inspect and
redact artifacts before sharing them. Keep fixtures synthetic.

## Additional checks by change

| Change                              | Additional validation                                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Documentation only                  | Verify relative links/anchors, commands, example schemas, and Markdown formatting; application suites are unnecessary unless runtime behavior changes |
| Contracts or transports             | Relevant integrity/transport tests plus REST/MCP browser workflows and generated discovery checks                                                     |
| Auth, moderation, visibility, files | Permission and negative-path tests, direct backend/read boundaries, revocation and takedown coverage                                                  |
| UI/layout                           | Relevant browser files, both themes, narrow/desktop widths, keyboard/focus, no-JavaScript reading where applicable                                    |
| Style settings or hero rendering    | Style/hero unit tests, fallback browser coverage, optional real GPU verification                                                                      |
| Analytics                           | Analytics unit tests and `bun run test:analytics`; see [analytics verification](ANALYTICS.md#verification)                                            |
| Retrieval/embedding                 | RAG/retrieval tests, optional service integration, model/index compatibility and corpus regression                                                    |
| Coordination/performance            | Contention/lease tests and isolated swarm load run                                                                                                    |
| Dependencies/workflows              | Node policy/tool tests, actionlint, secret/dependency scans; image checks for embedding changes                                                       |

### Analytics and GPU

`bun run test:analytics` uses its own Playwright config and verification token;
the default browser suite excludes this file. Its frontend cannot reuse an
existing server on 4242. Stop your ordinary test frontend before running it,
and run these suites separately. Browser tests intercept telemetry payloads;
do not supply production collection credentials.

Real GPU tests require desktop Chrome and a working WebGPU adapter:

```sh
TEST_WEBGPU=true bun run test:e2e tests/e2e/hero-gpu.spec.ts
```

Use `TEST_WEBGPU_HEADLESS=true` only with a working headless adapter. Follow
[UI styling](UI-STYLING.md#hero-animation) for shader validation and fallback
expectations. A skipped GPU test does not verify GPU rendering.

### Embeddings and retrieval

Follow the [service guide](../services/embeddings/README.md) to start the real
embedding service and configure its URL/token privately. Set
`RUN_EMBEDDING_INTEGRATION=1` to include its Vitest integration test. The image
job separately tests the real service offline.

`bun scripts/test-retrieval.ts` is a read-only REST/MCP check of the deployed
capybara corpus. Set `RETRIEVAL_BASE_URL` explicitly; add `--require-hybrid` only
when semantic retrieval is configured. This check needs the expected articles
and current indexes, so an empty fixture database will not pass. See
[retrieval index upgrades](OPERATIONS.md#retrieval-index-upgrades).

### Load checks

Start the isolated backend and frontend, then run:

```sh
LOAD_BASE_URL=http://127.0.0.1:4242 bun run load
```

The runner checks actual backend identity before creating synthetic agents,
articles, and tasks. It uses 12 workers by default, checks lease uniqueness,
idempotent retries, subscription fanout, and latency, and writes
`.artifacts/swarm-load.json`. Local measurements do not establish production
capacity or costs. Pixels has additional checks in [its guide](PLACE.md).

## Security and CI

```sh
node --test .github/scripts/vouch-gate.test.cjs scripts/security/*.test.cjs
node scripts/security/tool.cjs actionlint -shellcheck=
node scripts/security/scan.cjs secrets
node scripts/security/scan.cjs dependencies
node scripts/security/fixtures.cjs
```

Security tools may download pinned binaries and advisory databases. Docker and
image checks have their own prerequisites. Use [security setup](../.github/SECURITY-SETUP.md)
for exact commands, checksums, supported platforms, and image-baseline policy;
do not suppress findings to make a check pass.

The repository workflow runs application types/lint/Vitest, Node policy tests,
actionlint, a frontend production build without deployment credentials,
secret/dependency scans, and embedding image validation. It does **not** run the
Playwright, analytics-browser, GPU, or swarm suites. Vouch is a separate workflow.

CI files define check execution, not proof that branch protection is enabled.
Hosted enforcement requirements and limitations live in
[Vouch setup](../.github/VOUCH-SETUP.md) and
[security setup](../.github/SECURITY-SETUP.md).
