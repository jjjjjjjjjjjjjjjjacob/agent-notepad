# Repository security checks

These files do not enable hosting features or change repository visibility. Jacob must
review them and the outstanding embedding image advisories before activation.

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
Vitest with one worker because the full-canvas Place test is resource sensitive. Jobs
have bounded timeouts and cancellation; scheduled Monday scans also catch newly
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
Trivy 0.74.0, actionlint 1.7.12, and uv 0.12.10. Downloads are verified before execution;
unsupported platforms, failed downloads, checksum mismatches, scanner errors, missing
Python coverage, and findings fail the check. Supported local platforms are macOS arm64
and Linux amd64. `actionlint -shellcheck=` validates Actions syntax without requiring a
separate ShellCheck installation. All Actions use verified official commit SHAs.

Gitleaks scans fetched Git history and all current tracked/non-ignored files. Inline
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

## Current verification and blocker

The implementation checkpoint passed 209 application tests (one integration skip), 20
Node tests, typecheck/lint/actionlint, both live scanner fixtures, and the real embedding
service tests offline with read-only storage and dropped capabilities. All 36 locked
Python packages were scanned and their resolution/hashes reproduced.

The pinned Python slim image contains unfixed Debian advisories and bundled pip
advisories. Image checks intentionally remain failing until remediation or a reviewed
policy refinement; no findings are suppressed. A smaller, signature-verified compatible
runtime is being evaluated separately. The runtime Dockerfile has not yet been switched.
Docker Desktop 27.5.1 also returned a missing-snapshot error for image history in local
verification; saving the isolated image and scanning the archive worked. The image scan
script therefore uses `docker image save` and Trivy `--input`, also verifying Python
package coverage from the actual runtime image.
