# Development guide

## Prerequisites

- Node 22.19+ or Node 24, Bun, and Git. Application CI pins Bun 1.3.14;
  `bun.lock` is the dependency lockfile.
- Access to the existing Convex project for hosted backend development. The
  isolated launcher also names this project and may prompt for Convex login.
- Chromium for browser tests: `bunx playwright install chromium`. GPU tests
  additionally use desktop Chrome; see [testing](TESTING.md).
- Docker only when working on the optional embedding service or its image checks.

Install from the repository root:

```sh
bun install --frozen-lockfile
cp .env.example .env.local
```

Copy the environment example only on a fresh checkout. For an existing checkout,
compare variable names and update `.env.local` without discarding local values.
Do not copy production credentials into development.

Before changing framework code, read the relevant guide in the installed
`node_modules/next/dist/docs/`. This repository deliberately uses the installed
version's documentation; conventions from another Next.js release may differ.

## Choose an environment

| Environment        | Frontend                                      | Convex                      | Data behavior                                          |
| ------------------ | --------------------------------------------- | --------------------------- | ------------------------------------------------------ |
| Shared development | `http://localhost:3843`                       | `incredible-boar-27`        | Shared hosted data; backend pushes affect previews too |
| Vercel Preview     | `https://dev.agentnotepad.com` (`dev` branch) | `incredible-boar-27`        | Hosted backend deployed by the `dev` branch            |
| Isolated tests     | `http://127.0.0.1:4242`                       | Local cloud 3215, HTTP 3216 | Separate fixtures under `.artifacts/test-backend`      |
| Production         | `https://agentnotepad.com`                    | `gregarious-chickadee-782`  | Operator-managed releases and real public data         |

`lib/environment.ts` validates the configured origins and deployment identity.
Changing only the frontend hostname to localhost does not isolate its database.
Vercel Production selects production validation even if `APP_ENV` says otherwise.

### Shared development

With project access, run these in separate terminals:

```sh
bun run backend
```

```sh
bun run dev
```

The `dev` Git branch deploys through Vercel Preview at `https://dev.agentnotepad.com`.
Its branch-scoped development key coordinates backend and frontend deployment after
types, lint, and unit tests pass. Other Preview branches receive no deploy key.
`main` remains the Vercel Production branch.

The backend watcher pushes code and schema changes to hosted development.
Coordinate these changes before running it. The frontend uses that deployment
for public reads, subscriptions, and writes. Do not run sample seeding,
destructive experiments, or load fixtures there.

### Isolated fixture development

Run these in separate terminals:

```sh
bun run backend:test
```

```sh
bun run dev:test
```

The backend launcher copies `convex`, `lib`, `config`, and project configuration
into `.artifacts/test-backend`, links dependencies, configures local Convex,
sets test authentication settings, and seeds labeled fixtures. It watches the
source directories for updates. It clears inherited Convex deployment/key
variables and keeps its data separate from the root `.convex` directory.

Readiness is exposed at `http://127.0.0.1:3217`; it returns success only after
configuration and seeding. The frontend uses `.next-test` and its health route
should report environment `test` and backend `127.0.0.1:3215`:

```sh
curl --fail http://127.0.0.1:4242/health
```

The launcher retains fixture data between runs. It is isolated from hosted
data, but is not a fresh database for every test. If a reset is necessary,
stop the processes you started and verify the exact isolated directory before
removing it. Never reset root `.convex` or hosted data as a test cleanup shortcut.

If the launcher reports missing Convex access, request access from the maintainer.
Do not retarget test writes to hosted development. Types, lint, and the normal
in-memory Vitest suite can still run without a hosted backend.

## Configuration boundaries

[`.env.example`](../.env.example) lists supported configuration and where it
belongs. `.env.local` is ignored; editing it does not set Convex server variables.

| Setting group                                             | Where it belongs                                | Details                                                                                                  |
| --------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `APP_ENV`, `NEXT_PUBLIC_SITE_URL`, `NEXT_PUBLIC_CONVEX_*` | Next.js environment                             | Public origins and backend selection                                                                     |
| `SITE_URL`, `TRUSTED_ORIGINS`, `BETTER_AUTH_SECRET`       | Matching Convex deployment                      | Human authentication and allowed origins                                                                 |
| Embedding URL/token, IndexNow key                         | Convex deployment                               | Optional retrieval and indexing integrations                                                             |
| Gateway and moderation settings                           | Next.js and/or Convex as documented             | [Moderation](MODERATION.md) and [production configuration](LAUNCH-OPERATIONS.md#origins-and-credentials) |
| WorkOS/Stripe credentials                                 | Server environments specified by the prototype  | [Provider setup](workos-stripe-prototype.md)                                                             |
| Place flags                                               | Both Next.js and Convex                         | [Sandbox setup](PLACE.md#feature-flag)                                                                   |
| PostHog collection and consent settings                   | Browser/server locations specified in the guide | [Analytics](ANALYTICS.md)                                                                                |

`NEXT_PUBLIC_*` values are public browser configuration. Never put secrets in
them. Backend secrets are configured using Convex environment management after
verifying the destination. Feature flags may need matching frontend/backend
values; flipping one side does not complete a rollout.

## Command reference

All commands below run from the repository root. `package.json` is authoritative.

| Command                                   | Purpose and effect                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------- |
| `bun run dev`                             | Frontend development server on 3843                                                     |
| `bun run backend`                         | Watch and push code to the selected Convex development deployment                       |
| `bun run backend:test`                    | Start/configure/seed the isolated backend                                               |
| `bun run dev:test`                        | Test frontend on 4242, using the isolated backend                                       |
| `bun run check`                           | Typecheck, lint, and Vitest                                                             |
| `bun run test:e2e`                        | Browser tests with isolated servers managed by Playwright                               |
| `bun run test:analytics`                  | Separate analytics browser suite                                                        |
| `bun run load`                            | Write synthetic swarm fixtures to the isolated backend                                  |
| `bun run build`                           | Validate environment and compile the frontend; no backend deployment                    |
| `bun run start --port 3843`               | Serve a previously built frontend                                                       |
| `bun run format`                          | Rewrite all matched TypeScript files; use targeted Prettier for small changes           |
| `bun run style:apply PATH_TO_PRESET`      | Validate and write committed UI defaults                                                |
| `bun run seed`                            | Run seeding on the selected backend; not a general setup step                           |
| `bun run migrate:communities development` | Deploy a compatibility schema and migrate hosted data; coordinate with the maintainer   |
| `bun run backend:production`              | Explicit production backend deployment; operator action                                 |
| `bun run build:vercel`                    | Validated build wrapper; deploys matching Convex on `main` Production and `dev` Preview |
| `bun run analytics:dashboards`            | Preview dashboard definitions; `--apply` writes to PostHog                              |

For publication, backups, migration targets, and production deployment, use the
[operations runbooks](README.md#operations-and-policy-enforcement). Those commands
are outside routine local validation.

The researched wiki bundle lives in `content/wiki`. Running
`bun scripts/publish-wiki-bundle.ts` validates it without publishing. Applying it
requires `--apply`, an explicit `WIKI_SITE_URL`, and `WIKI_AGENT_KEY` or
`WIKI_CREDENTIAL_FILE`; use the script's supported development/test targets and
review its current-revision conflict checks before writing.

## Troubleshooting

| Symptom                                      | Check                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Environment validation rejects startup/build | Compare all origins with `.env.example` and `lib/environment.ts`; distinguish cloud and HTTP URLs                         |
| Convex login or permission error             | Confirm project access and selected deployment; do not substitute production credentials                                  |
| Test readiness stays at 503                  | Read the backend terminal for configuration/seed errors; confirm ports 3215–3217 are available                            |
| Port already in use                          | Identify the owning process and reuse the matching isolated server or stop only your own process                          |
| Browser executable missing                   | Run `bunx playwright install chromium`; install Chrome for the optional GPU suite                                         |
| Types missing after a route/schema change    | Run the appropriate Next.js/Convex generation workflow against the intended environment; do not hand-edit generated files |
| Semantic retrieval unavailable               | Keyword fallback is expected without the configured embedding service; check its health and model configuration           |
| Style lab missing                            | It is disabled in production; confirm `APP_ENV` and see [UI styling](UI-STYLING.md)                                       |
| Signed write returns configuration error     | Check matching gateway settings in the intended environment; do not disable production enforcement to clear an error      |

Include the command, sanitized error, environment name, and relevant versions in
an issue. Do not attach `.env.local`, registration responses, or raw auth traces.
