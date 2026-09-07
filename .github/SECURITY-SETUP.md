# Repository security checks

These files do not enable hosting features or change repository visibility. Jacob must
review them and the time-limited embedding image advisory baseline before activation.

## Hosted activation

Keep Jacob as the only writer/merger. Retain read-only default workflow permissions,
disable Actions creating/approving PRs, and require approval of workflows from all
outside collaborators. Anyone may open issues or fork/draft PRs. Application CI runs
on `pull_request`, never `pull_request_target`, with no secrets or write token.

After the repository becomes public or its plan permits enforcement, configure the
main ruleset described in [VOUCH-SETUP.md](VOUCH-SETUP.md). Require the observed GitHub
Actions check sources and these exact names:

- `Vouch / trusted contributor`
- `Application validation`
- `Secret and dependency scans`
- `Embedding image validation`

Require branches to be up to date. The private personal Free repository cannot currently
enforce these rulesets; CODEOWNERS alone is not a security boundary. Dependency alerts
and SHA-pinning policy were enabled separately; verify their settings when activating.
When eligible, enable private vulnerability reporting, secret scanning/push protection,
and CodeQL default setup for JavaScript/TypeScript and Python in Settings → Advanced
Security. Feature availability depends on repository visibility and plan. No paid
service, new writer bot, auto-merge, or trust exemption is configured here.

## Checks and updates

Application CI pins Bun 1.3.14, uses frozen installation, checks types/lint, and runs
Vitest with one worker because the full-canvas Place test is resource sensitive.
Application validation also builds the production frontend with public origins and no deployment credentials.
Vercel Production Deployment Checks require Application validation, Secret and
dependency scans, and Embedding image validation before production alias assignment;
these checks do not replace branch protection or delay the Convex push inside a build.
Jobs have bounded timeouts and cancellation; scheduled Monday scans also catch newly
published advisories against unchanged dependencies. Fork workflow approval remains
manual. The optional external embedding integration test is skipped without its explicit
configuration; the separate image job runs the real service tests without network access.

Run locally from the repository root:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bunx vitest run --maxWorkers=1
node --test .github/scripts/vouch-gate.test.cjs scripts/security/*.test.cjs
node scripts/security/tool.cjs actionlint -shellcheck=
node scripts/security/scan.cjs secrets
node scripts/security/scan.cjs dependencies
node scripts/security/fixtures.cjs
```

The tools manifest pins release assets and SHA-256 hashes for Gitleaks 8.30.1,
Trivy 0.74.0, actionlint 1.7.12, uv 0.12.10, and Cosign 3.1.3. Downloads are verified before execution;
unsupported platforms, failed downloads, checksum mismatches, scanner errors, missing
Python coverage, source findings, and unreviewed image findings fail the check. Supported local platforms are macOS arm64
and Linux amd64. `actionlint -shellcheck=` validates Actions syntax without requiring a
separate ShellCheck installation. All Actions use verified official commit SHAs.

Gitleaks separately scans fetched Git history, Git index blobs, and current
tracked/non-ignored files, including staged content overwritten or deleted in the
working tree. Unmerged or unsupported index entries fail closed. Ordinary and
executable blobs are scanned; symlink blobs are scanned as text without following
their targets. Gitlinks refer to commits and are excluded from the blob snapshot;
submodule contents require their own repository scan. Working-tree symlinks are
not followed. Inline
`gitleaks:allow` comments are ignored by the gate. History scanning uses full fetch in CI;
local shallow clones must fetch their missing history. Ignored local environment files
are not copied into the scan staging directory, and no environment files or secret-match
reports are uploaded. Scanner subprocess output is captured and discarded. For manual
triage, use the pinned Gitleaks tool with `--redact=100 --ignore-gitleaks-allow`; rotate
any real exposed credential and review history remediation separately.

Dependabot checks Bun at `/`, Python/Docker at `/services/embeddings`, and GitHub Actions
at `/` weekly with small open-PR limits. Review update diffs and upstream releases; update
Actions' full SHAs and tool checksums from official release metadata. Dependabot cannot
bypass Vouch or merge its own updates. Regenerate and inspect the Python lock after input
updates using the embedding README; preserve the model revision and preprocessing.

## Image baseline and review

The runtime uses a keyless-signature-verified, digest-pinned Distroless Debian 13
nonroot base, Python 3.12.14 from the official pinned Python builder, and all 36
locked distributions. Complete libffi8, libbz2-1.0 and liblzma5 package contents retain
their dpkg records and per-file hashes. Pip and ensurepip are excluded. The signature
step verifies the documented Google issuer and identity before each CI build; a digest
alone establishes content identity, not publisher identity. See the embedding README
for the exact update procedure and optional standard-library limitations.

[`scripts/security/image-advisories.json`](../scripts/security/image-advisories.json)
contains the 21 reviewed residual findings (14 medium, 7 low), each keyed by exact
Debian distribution version, package, package version, and CVE. Every entry includes
its primary Debian source, rationale, maximum severity, review date, and expiry.
The current review expires **2026-10-06 at 00:00 UTC**, exclusively. No finding is
classified as proven unreachable or a false positive; native transitive reachability
remains uncertain. The API does not offer archive recovery, C format strings, or shell
expansion. Conflicting applicability details for CVE-2026-85091 are retained.

The image scan prints every advisory and its decision and appends the same table to
the CI summary. Trivy runs without ignore or severity filters in a fresh directory,
with inherited Trivy configuration cleared. New, unknown-severity, high/critical,
higher-than-reviewed, fixable, unreviewed, expired, and malformed entries fail the check.
Source and Python-package scans cannot use the image baseline. Duplicate records,
invalid dates, future reviews, and review periods over 30 days fail validation. Even an
expired unused entry requires removal or review. The baseline is never refreshed
implicitly: Jacob must assess primary advisories, update/remediate dependencies where
possible, review the exact diff, and rerun scans/tests before any renewal.

The isolated verification passed the full application suite, Node policy/tool tests,
typecheck/lint/actionlint, both live scanner fixtures, and the real embedding service
tests without network access. Exact runtime package versions and copied file hashes
are checked by the service test runner. Runtime image scanning retains both OS and
Python inventory. Docker Desktop 27.5.1 returned a missing-snapshot error for image
history, so the portable image scanner uses `docker image save` and Trivy `--input`.
No unrelated Docker objects are stopped or removed by these checks.
