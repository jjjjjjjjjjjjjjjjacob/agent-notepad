# Security hardening review — September 6, 2026

Status: **audit and local hardening complete; approved for integration review**. Final reviewed commit: `21725f66b60f6912fbca0e18a176c2c2be9ee06b`.

Repository: `jjjjjjjjjjjjjjjjacob/agent-notepad`. Application baseline: `e1dad6e`. Prepared branch: `codex/security-hardening`, in `/tmp/agent-notepad-security-integration-20260906`. The original application checkout and its concurrent UI work are preserved; audit documents live in its `plans/` directory. The repository is still private; application fixes and new workflows have not been pushed, merged or deployed.

## Contributor policy

The requested model is preserved: anyone can read, fork, open issues and propose draft pull requests once the repository is public; Jacob alone retains repository write and merge authority. [Mitchell Hashimoto's Vouch](https://github.com/mitchellh/vouch) supplies explicit vouched/denounced records, rather than an automatic numerical reputation score. Vouching never grants collaborator permissions.

The canonical trust list initially contains only Jacob. Fork edits cannot self-vouch. Unknown contributors and drafts remain open; the workflow controls eligibility for review/merge and does not auto-close, comment, lock or merge. Bot and collaborator exemptions cannot override the explicit list. Evaluation has read-only credentials, with status publication isolated in a trusted job that rechecks canonical policy and the current PR head.

## Implemented and reviewed

| Area | Result |
| --- | --- |
| Quarantined reports and derivative tasks | Source report/revision provenance prevents withheld text escaping through task titles, descriptions, assignment delivery or public reads. |
| Moderation evidence | Reporters receive their own statements; subjects receive explicitly attributed authored material. Full forensic records remain for authorized reviewers. Large records are stored without repeated serialization growth. |
| Knowledge and retrieval | Graphs, details, related tasks and author labels use shared visibility rules, with bounded reads and regression tests for integrity fallback and held profiles. |
| WorkOS | Reused configuration-aware SDK/JWKS state plus durable authentication admission bounds provider work, while live issuer, audience, actor, expiry, revocation, registration and ownership checks remain. |
| Retention and reputation | Bounded resumable cleanup drains expired records; versioned asynchronous reputation work preserves atomic public voting, owner deduplication and anti-collusion checks. Evidence retirement prevents partial inheritance. |
| Jury authority and capacity | Frozen historical owner exclusions and live conflicts are shared across evidence, seating, ballots, closure and administrator actions. Incomplete attribution preserves evidence and withholds decisions. |
| Sandbox wallet | Auctions enforce sandbox mode before writes. Exact pending-capacity reservations and bounded reconciliation preserve unresolved obligations without endless automatic retries. |
| Repository CI and supply chain | Read-only contributor CI, pinned actions/tools, secret/dependency scans, update proposals, hashed Python dependencies, signed base verification and real isolated embedding tests are prepared. |

The baseline's one high, six medium and two low application findings were addressed in these changes. Verification also caught a transaction rollback defect: decision-stage capacity failures cannot commit a partially resolved moderation case. Additional capacity/consistency findings discovered during verification were included. The detailed historical evidence remains in [the baseline audit](security-audit-2026-09-05.md); plan-by-plan review records are in [the verification log](security-hardening-log.md).

## Verification

Independent review included every changed implementation hunk and meaningful regression assertions. Tests use harmless local fixtures; large-input regressions enable actual Convex transaction limits. Providers are mocked where noted; no live penetration or load test was performed.

| Check | Recorded result |
| --- | --- |
| Individual application plans | Primary typecheck/lint and relevant suites passed for 002–006/008. |
| Final combined application suite | 312 passed; one pre-existing opt-in external embedding integration test skipped. Primary typecheck/lint also passed. |
| Browser workflows | 24 passed in the primary final run at application source `967d16d`, using a fresh separate local backend on alternate loopback ports. |
| Production build | Primary final optimized build completed at application source `967d16d`, including TypeScript and 18 static pages, against the isolated test environment. |
| CI package independent rerun | 209 application tests passed, one existing skip; 27 Node policy/tool tests; typecheck/lint/actionlint passed. The final combined Node suite passed all 31 tests at the final commit. |
| Secrets and dependencies | Redacted history/index/current-tree scans and live detection fixtures passed, including staged secrets overwritten or deleted from the working tree; Bun audit clean; all 36 Python packages/hash pins reproduced and audited. |
| Embedding image | Signature verification, independent rebuild, actual-image scan, exact package/file provenance checks and real HTTP/vector tests passed offline, nonroot, read-only and with capabilities dropped. The updated runner also passed the archive-bypass and missing-cache guards at the final commit. |

The final commit differs from application source `967d16d` only in seven CI/test/documentation files; production application code and files copied into the image are identical. The tested embedding image configuration is `sha256:5af27acea1892ff7ab6cdcd1c34644859061fbdb3598526ed2c4e6f9bb5dff5a`.

Original timeouts were retained. One governance stress-test timeout under concurrent container work passed in isolation and in the subsequent scoped run. The browser/build checkout changes only exact test port literals because the user's normal test services occupied the defaults; its temporary diff is preserved. Concurrent uncommitted UI work in the original checkout is not part of the tested security branch.

## External review triage

The full CodeRabbit review completed with five suggestions, all independently checked:

| Lead | Disposition |
| --- | --- |
| Staged secret overwritten/deleted in working tree | Confirmed and fixed; actual scanner regression and redaction checks passed. |
| SHA-bound Vouch status inheritance | Real GitHub status race documented; shared-head rechecks remain, and only Jacob has write/merge authority. A status is not PR identity proof. |
| Unused, unexpired image advisory entries | No security bypass established. Exact distro/package/version/CVE matching cannot excuse a different finding, and expiry remains enforced. |
| Missing resource revision non-null assertion | Already fails before writes; structured error handling is diagnostic cleanup, with no additional security effect established. |
| FastEmbed archive helper | Unsafe dependency code confirmed; the service bypasses it. Verified the bypass against the actual image and added a permanent regression guard. |

A narrow external rereview of the scanner correction was attempted but rate-limited by CodeRabbit's free allowance. No paid capacity was used. The correction received independent full-diff review and passing local/live tests; no successful external rereview is claimed.

## Residual risk and deployment limits

- The embedding image retains **21 unfixed Debian findings: 14 medium and 7 low**. The exact-version review expires **October 6, 2026 at 00:00 UTC**. Findings stay visible. New, fixable, elevated, unknown, malformed or expired findings fail CI. These are accepted residual risks, not proven false positives or unreachable code. No Python/high/critical findings appeared in the scanned runtime.
- FastEmbed 0.8.0 contains an unsafe archive-extraction helper. This service bypasses it: a fixed Hugging Face model revision is downloaded directly, then loaded through `specific_model_path`; runtime is offline. A primary check against the actual image produced a real normalized vector with every archive/fallback helper forbidden, and an empty cache failed without fallback. A permanent CI guard now checks this boundary. Reassess before adding dynamic model or archive sources; this is a dormant dependency hazard, not a scanner-reported advisory. [Upstream issue](https://github.com/qdrant/fastembed/issues/626), [exact release source](https://github.com/qdrant/fastembed/blob/v0.8.0/fastembed/common/model_management.py).
- WorkOS's deployment-wide cap can temporarily deny legitimate authentication when exhausted. Governance limits deliberately withhold credit or escalate when safe attribution cannot be established. Saturated authorship cases require a separately reviewed recovery procedure; there is no conflict override.
- Vouch's upstream action still downloads a floating Nushell runtime inside its read-only evaluator. GitHub commit statuses belong to a commit SHA, not a unique PR identity. The gate evaluates every currently open PR sharing that head, but a newly opened or changed same-head PR can briefly inherit a previous result before refresh. Strict up-to-date branches and successful current refreshes are required; Jacob must verify the actual PR author against canonical trust before merging. No status grants repository write permission. More than 256 open PRs leaves the gate pending until batching is extended.
- Hosted Convex inspection found distinct development/production auth secrets and explicit production HTTPS origins. Neither deployment currently has moderation/gateway/classifier/admin, WorkOS, Stripe or Place environment configuration. Optional protections/integrations must be configured and tested before being described as active.
- GitHub App permissions, account 2FA/passkeys, PATs/SSH keys, provider edge controls and backup restore acceptance remain outside verified access. No finding-free scanner proves absence of vulnerabilities. Real provider calls, deployed acceptance, live load testing and backup restore drills were not exercised.

During browser-test cleanup, a process listing exposed the generated credential for our own disposable local Convex instance in a tool response. That instance was stopped and its local data/configuration deleted. Final verification used a newly generated disposable instance, which was also stopped and removed afterward; all alternate ports are closed. No tracked, main or hosted credential was involved. The value is not reproduced in this report, and the existing tool transcript cannot be erased.

## Hosted activation

Already verified: GitHub vulnerability alerts enabled; full commit SHA pinning required for Actions; default tokens read-only; workflow PR approval disabled. Jacob remains the sole listed writer. The current private personal plan does not permit the required branch protection/rulesets.

Before relying on the prepared controls:

1. Review and integrate the final security branch while preserving the concurrent UI work.
2. Publish the repository or use an eligible GitHub plan, retain Jacob as sole writer and audit installed applications/account credentials.
3. Activate main protection, block force pushes/deletion, require PRs, strict up-to-date branches, Vouch and the three validation checks. Do not require an impossible self-approval from Jacob.
4. Require approval for all outside-contributor workflows; enable available private vulnerability reporting, secret/push protection and code scanning.
5. Test the hosted Vouch states and source-bound required checks, then deploy reviewed application changes and complete acceptance for each enabled integration.

The prepared [Vouch setup](/tmp/agent-notepad-security-integration-20260906/.github/VOUCH-SETUP.md) and [security setup](/tmp/agent-notepad-security-integration-20260906/.github/SECURITY-SETUP.md) contain exact check names and activation details. Local tests do not establish hosted enforcement.
