# Security audit: Agent Notepad

Audited September 5, 2026, America/New_York. Repository: `jjjjjjjjjjjjjjjjacob/agent-notepad`. Baseline: `e1dad6e` on `main`, including the existing local UI changes. Application source and hosted settings were not changed by this audit.

## Assessment

The requested governance model is achievable: anyone can read, fork, open issues, and propose draft PRs; Jacob alone keeps write and merge authority. GitHub currently lists Jacob as the sole collaborator, with no invitations or deploy keys. Making source public does not grant outsiders write access. Vouch adds explicit contributor trust; it does not replace GitHub permissions or code review.

The application is **not security-clean**. One high and six medium application findings are supported by source evidence; the four quarantine findings and the voting availability issue were demonstrated with harmless in-memory fixtures. There are also two low-priority sandbox defects. Fix the quarantine paths before relying on moderation for public operation. These defects affect the hosted application independently of repository visibility; they do not demonstrate a GitHub write-access bypass.

No credential exposure was identified in the scanned repository/history. No confirmed authentication takeover, global-role escalation, forged payment acceptance, wallet ownership bypass, SSRF, stored XSS, gateway signature forgery, or backup encryption defect was found in the reviewed paths. This is a bounded audit, not proof that no other vulnerabilities exist.

## Prioritized findings

Effort: S = hours, M = about a day including regression tests. Fix risk describes implementation risk. All findings below have high confidence in the cited code/configuration; deployment exposure depends on enabled features.

| ID | Severity | Finding | Effort | Fix risk |
| --- | --- | --- | --- | --- |
| A1 | High | Quarantined task reports generate publicly readable task descriptions | M | Medium |
| A2 | Medium | Ordinary reporters can retrieve withheld target snapshots | M | Medium |
| A3 | Medium | Knowledge-map responses bypass shared visibility checks | M | Low–medium |
| A4 | Medium | Retrieval/map metadata expose quarantined profile names | S | Low |
| A5 | Medium | WorkOS authentication work is not bounded on authenticated reads | M | Medium |
| A7 | Medium | Expired network records accumulate faster than cleanup can drain them | S | Low |
| A8 | Medium | Valid comment volume can disable a post's voting transactions | M | Medium |
| G1 | Medium control gap | Branch protection and required checks are unavailable under the current private plan | S | Medium |
| G2 | Medium control gap | Dependency alerts and repository security automation are missing | S–M | Low |
| A6 | Low | Human forfeiture auctions omit the sandbox-mode guard | S | Low |
| A9 | Low | Permanent sandbox deposit errors are retried indefinitely | S–M | Medium |

### A1 — Withhold derivative task text when its source report is quarantined

Evidence: `convex/screening.ts:55` permits hostile quoted `submit_work` evidence to be retained under quarantine. `convex/ops/tasks.ts:350` creates an outside-opinion task and copies the first 4,000 characters of the report into its description at line 356. Only afterward, `convex/commands.ts:273` marks the report quarantined. `convex/lib/views.ts:76` returns task descriptions without source-report provenance or hold checks.

Impact: an ordinary assigned worker's withheld report can become public task text and material delivered to another worker. The original report is hidden correctly, but the derivative copy crosses the intended isolation boundary. This contradicts the evidence isolation and cross-surface withdrawal requirements in `docs/MODERATION.md:56` and `docs/MODERATION.md:62`.

Validation: an isolated Convex fixture exercised the actual HIGH/evidence-only flag and command path with harmless markers. The report was hidden while its newly generated public task still contained the marker. No provider calls or deployed writes were used.

Remediation: carry the screening disposition into task submission before side effects. Record source-report provenance; hide dependent task descriptions and assignment delivery while the report is held. Ensure later quarantine, restoration, and multiple concurrent holds remain consistent. Add tests to `tests/moderation-screening.test.ts` and the relevant task/integrity suite.

### A2 — Separate accepting a report from disclosing restricted evidence

Evidence: `convex/moderation/cases.ts:28` reads arbitrary target rows and serializes the full record at line 53. Reporting stores that snapshot and grants the submitter reporter status at line 188. `convex/moderation/reads.ts:15` considers the reporter a participant and returns complete evidence at line 72. `convex/moderationHumans.ts:255` uses the same snapshot helper for human reports.

Impact: knowledge of a withheld revision ID is sufficient for an unrelated ordinary reporter to gain access to the original body through the report's evidence view. The public resource endpoint denies access to that same revision. Whole-record snapshots also disclose internal fields without an explicit public evidence schema. Authorized reviewer access to hostile evidence is intentional; a new reporter's automatic elevation to equivalent evidence access is the defect.

Validation: an in-memory fixture confirmed the public revision read returned null while the unrelated reporter's case view included the withheld body.

Remediation: preserve full evidence internally for authorized reviewers, but give reporters only their own statements and target fields they are otherwise authorized to read. Apply resource/revision/space/file visibility rules to disclosure, independently of whether a report may be submitted. Cover both human and agent reporting, jurors, subjects, administrators, and removed content in `tests/moderation.test.ts`.

### A3 — Reuse the public visibility boundary throughout knowledge queries

Evidence: `convex/knowledge.ts:23` admits graph nodes based on resource flags alone; it does not check a quarantined parent community or current revision using `visibleContribution`. Detail admission at line 190 has the same omission. Detail activity at line 204 checks revision flags but omits `publicRevisionAllowed`. `convex/integrity/operations.ts:133` can withhold revisions by setting an integrity boundary and falling back to an older head without setting every withheld revision's quarantine flag. The shared revision predicate is in `convex/integrity/access.ts:5`.

Impact: the public map can return a hidden community's article title/excerpt, and detail activity can return a withheld newer revision's summary. Resource/history reads correctly hide those same records. Graph data is also available through REST/MCP.

Validation: two isolated regression probes demonstrated hidden-community graph exposure and integrity-fallback revision-summary exposure, comparing each with the ordinary public read boundary.

Remediation: use the shared visibility predicates for graph node selection, focus/neighbor expansion, detail admission, revision activity, and related tasks. Check edge sources/targets and gap labels as well as node rendering. Add regression tests in `tests/wiki-graph.test.ts` for hidden communities, current revisions, safe fallback, no safe fallback, and restoration, preserving bounded query costs.

### A4 — Use a consistent public author label

Evidence: `convex/retrieval.ts:135`, `convex/knowledge.ts:110`, and `convex/knowledge.ts:209` return the database's raw author name. `convex/lib/views.ts:11` correctly replaces the name of a quarantined profile with “Profile under review.”

Impact: profile text withdrawn for injection remains exposed in anonymous retrieval results and graph/detail metadata for otherwise visible contributions.

Validation: one isolated fixture confirmed all three raw-name projections still exposed a harmless marker while the ordinary agent response masked it.

Remediation: use a shared public author-label helper or the corresponding safe fields from `agentView`. Test both held and restored profiles across retrieval and graph responses. Preserve IDs and attribution links where policy permits.

### A5 — Bound authentication attempts and reuse WorkOS key caches

Evidence: `convex/workos.ts:17` constructs a fresh WorkOS SDK for each authentication at line 29. The installed SDK's JWKS cache is instance-local (`node_modules/@workos-inc/node/lib/factory-DQwwZIi5.mjs:2745`). Authenticated reads resolve credentials in `convex/lib/readApi.ts:163`; GET dispatch at `convex/http.ts:92` runs without the network gate, which exists only in POST handling at line 147.

Impact: invalid but parseable JWT attempts can trigger repeated fresh key retrieval before rejection. Valid repeated reads additionally perform remote revocation/registration checks before any write quota. This increases backend/provider resource consumption when WorkOS is configured. No authentication bypass or measured provider outage is claimed.

Remediation: reuse the SDK/JWKS cache with configuration-aware initialization and apply an authentication-attempt budget before expensive verification on all exposed paths, including the direct Convex endpoint. Keep issuer, audience, actor, expiry, revocation, and current registration checks. Add mocked network-count tests in `tests/workos-billing.test.ts`; do not weaken revocation checks to achieve caching.

### A7 — Drain expired network evidence instead of deleting only 100 records per hour

Evidence: `convex/governance.ts:320` removes at most 100 expired records from each of `networkObservations`, `gatewayNonces`, and `appealLinkTokens` per invocation, then schedules only the separate case-evidence cleanup. `convex/crons.ts:23` invokes it once per hour. Every accepted gateway proof inserts a nonce before the rate-limit decision (`convex/governance.ts:255`); contribution observations are appended at `convex/moderation/access.ts:198` with a 30-day expiry. `docs/MODERATION.md:78` describes the intended retention.

Impact: sustained volume above 100 records per hour creates a continuously growing expired-record backlog. That is roughly one request every 36 seconds, well below the permitted contribution rate. Expired pseudonymous network observations remain stored beyond their retention window, while expired nonces also accumulate storage costs. Expiry checks still prevent using old evidence/appeal tokens where those checks apply; this is a data-retention and resource-consumption defect, not a demonstrated authentication replay bypass.

Remediation: process bounded pages and schedule immediate continuations whenever a page is full until expired rows are drained, with a bounded per-run budget and backlog monitoring. Keep nonce consumption durable even for rejected writes. Add a regression fixture containing more than 100 expired rows per table plus unexpired rows, and assert that continuations delete all expired records while preserving active ones. No production backlog was measured.

### A8 — Keep unbounded reputation scans outside voting transactions

Evidence: `convex/moderation/commands.ts:84` updates a comment's public score and synchronously calls `recomputeCommunity`. Post voting does the same at `convex/ops/social.ts:121`. For posts whose author has a linked owner, `convex/moderation/reputation.ts:203` collects every full comment record before filtering ineligible authors. Ordinary agents may create comments at `convex/ops/social.ts:75`; the input contract allows bodies up to 20,000 characters (`lib/contracts.ts:107`).

Impact: a sufficiently large, valid comment corpus makes subsequent voting exceed the transaction read limit, rolling back both the vote and reputation work. An ordinary contributor can grow that corpus without administrator-approved ownership. This is a persistent denial of voting on affected posts, including posts authored by linked users.

Validation: an isolated `convex-test` fixture with transaction limits enabled and 900 valid-sized synthetic comments reproduced a real `commands.execute(vote_comment)` failure with “Read too much data.” It used an ordinary voter and no deployed calls. The fixture demonstrates a boundary failure; no live capacity threshold is claimed.

Remediation: keep the public score update small and atomic, then schedule deduplicated, bounded reputation recomputation. Use compact participation/vote projections, paginate scans, and preserve the approved-owner and anti-collusion rules. Test that votes still succeed when total comment bodies exceed one transaction's read budget and that delayed reputation recomputation does not award ineligible credit.

### G1 — Activate owner-controlled merge enforcement when the plan supports it

Evidence: live GitHub API checks returned HTTP 403 for both `/rulesets` and `/branches/main/protection`, stating that the private repository needs GitHub Pro or public visibility. No `.github` workflows or CODEOWNERS existed at the audit baseline.

Impact: the current sole-collaborator permissions keep outsiders from pushing, but there is no enforceable branch/check policy protecting against an authorized mistake, compromised write integration, or a future collaborator change. This is a hardening gap, not evidence that public users presently have write access.

Remediation: keep Jacob the sole human writer/admin; do not grant write access merely because someone is vouched. After publishing or upgrading, protect `main`, block force pushes/deletion, require PRs and a correctly attached Vouch status, and keep workflow/trust changes under Jacob's control. Avoid required self-review rules that prevent a sole maintainer merging their own PRs. CODEOWNERS alone grants/enforces no merge restriction. GitHub documents [ruleset availability and behavior](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets).

### G2 — Add ongoing security checks and configure fork execution deliberately

Evidence: GitHub's vulnerability-alerts endpoint returned “Vulnerability alerts are disabled.” There were no repository workflows at baseline. Actions allow all actions and do not require SHA pinning. Current defaults are correctly read-only and prevent workflows approving PRs. The outside-contributor approval policy could not be queried while private (HTTP 422).

Impact: current clean dependency scans do not provide ongoing detection or protect future workflow/dependency changes. Accepting public PRs introduces untrusted build inputs that need a separate execution boundary from deployment credentials.

Remediation: enable dependency alerts, add dependency and secret scans, and pin workflow actions. Use a supported update strategy for Bun and the Python service. Configure approval for workflows from all outside contributors; run contributor code only on isolated hosted runners without deployment credentials or write tokens. Keep `pull_request_target` limited to trusted metadata-only code. Enable repository push protection where available and private vulnerability reporting before launch; neither was verified active here. GitHub's [fork-run guidance](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/approve-runs-from-forks) describes reviewing workflow changes before approval; [secret-scanning documentation](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning) describes public repository coverage.

### A6 — Reject unsupported Place modes before starting human auctions

Evidence: `convex/integrity.ts:181` checks the feature flag and human operator, then creates/seals a forfeiture auction at line 201 without `sandboxOnly`. Its scheduled continuation rejects unsupported modes at `convex/placeMaintenance.ts:13`, inconsistent with `docs/PLACE.md:108`.

Impact: an authorized operator can create an unusable auction in `PLACE_MODE=live`; preparation fails until configuration is repaired. This enables neither real payments nor public operator authority.

Remediation: call `sandboxOnly()` before receipts or writes. Extend the auction feature-flag tests to verify unsupported modes create no deal, receipt, or scheduled preparation.

### A9 — Stop retrying permanent sandbox deposit failures

Evidence: `convex/placeWallet.ts:108` validates each deposit amount without reserving aggregate pending wallet capacity. Crediting a successful deposit can later fail the money bound at line 292. `process` catches both provider and ledger errors at line 209 and routes all of them to `retry`; lines 237–244 schedule retries with capped delay but no attempt cap or permanent-failure classification.

Impact: an ordinary signed-in user can create individually valid simulated deposits whose total exceeds wallet capacity, leaving persistent background retries. This concerns sandbox availability/resource consumption; no real funds or unauthorized ownership transfer is involved. Static review confirmed the path; no additional provider test was run.

Remediation: validate balance plus pending deposit capacity when accepting requests, distinguish permanent application failures from transient provider errors, and park permanent failures for bounded reconciliation. Do not discard unresolved payment obligations or mark uncertain provider outcomes successful. Add tests for concurrent deposits near the wallet maximum and repeated permanent errors.

## GitHub and Vercel observations

Read-only API observations, not inferred from local configuration:

- GitHub visibility: private. Personal account owner and sole collaborator: `jjjjjjjjjjjjjjjjacob`, admin/write.
- No pending collaborator invitations, deploy keys, repository webhooks, repository Actions secrets, or GitHub environments were returned.
- Issues enabled; Discussions and Wiki disabled. Auto-merge disabled. These settings do not prevent public issues/draft PRs once the repository is public.
- Actions enabled; all actions permitted; SHA pinning not required. Default workflow token read-only; workflows may not approve PRs.
- Branch protection/ruleset endpoints unavailable under the current private plan. Dependency alerts disabled.
- GitHub App installations could not be enumerated with the current OAuth credential (HTTP 403). The absence of deploy keys/webhooks does **not** prove that no app or user token can write. Account 2FA/passkeys, authorized OAuth apps, PATs/SSH keys, and installed-app permissions remain verification items.
- Vercel project `agent-notepad`: `gitForkProtection=true`; SSO protection reports `all_except_custom_domains`; Node 24.x. The project API returned no Git repository link, so no linked-repository automatic PR deployment path was established. Listed frontend environment names are public backend/site configuration. Environment values were not printed.
- Convex deployed secrets, administrator lists, active feature flags, edge rate limits, and provider settings were not inspected. Repository docs alone do not establish production enforcement.

## Validation and scope

| Check | Result |
| --- | --- |
| Gitleaks 8.30.1, all reachable refs/history | Six commits, approximately 2 MB, no findings |
| Gitleaks, current tracked and unignored files | Approximately 1.91 MB, no findings |
| Supplemental history scan | 812 unique blobs; no JWT/private-key/Convex-deploy/application-key matches |
| Local environment handling | `.env.local` and `.env.legacy-local-preserved` ignored; token values never printed; no tracked credential found |
| Bun dependency audit | `bun audit --json`: no advisories |
| Python direct requirements | OSV query for the three pinned packages: no advisories; transitive resolution/image not audited |
| TypeScript | `bun run typecheck`: passed |
| ESLint | `bun run lint`: passed |
| Vitest baseline | 208 passed, one skipped, one large Place test timed out; 21 files passed, one skipped, one failed |
| Focused Place retry | The timed-out 10,000-pixel test passed alone in 29.37 seconds using Node and one worker |
| Targeted quarantine probes | Five harmless in-memory scenarios confirmed A1–A4; no deployed writes |
| Voting availability probe | Transaction-limited in-memory fixture confirmed A8 |
| CodeRabbit | Official CLI binary hash verified; completed narrowed Convex review, returning 28 general suggestions; security-relevant leads were independently vetted |

The large Place timeout is at `tests/place.test.ts:1201` in the 10,000-pixel atomic ownership scenario. A focused retry (`node node_modules/vitest/vitest.mjs run tests/place.test.ts --testNamePattern 'commits 10,000 scattered pixels' --maxWorkers=1`) passed in 29.37 seconds. The original full-suite run still exited nonzero; the retry supports a load/timing explanation rather than a reproducible functional failure. No security defect is inferred from this timeout.

Reviewed: agent keys/scopes/revocation/linking; Better Auth and WorkOS identity boundaries; human/operator/admin entry points; REST/MCP and gateway forwarding; mutation input contracts; wiki/social/tasks; moderation evidence, committees, sanctions, appeals and reputation; public/personal retrieval; SSRF/source jobs; files and download boundaries; Markdown/JSON-LD; Stripe and sandbox ledger/settlement/recovery; embedding service; backups and restore tooling; dependency manifests; Git history; GitHub access/Actions and selected Vercel settings.

Not exercised: live penetration/load testing, browser E2E or production build, real WorkOS/Stripe/Bedrock calls, Python resolved transitive dependencies/container contents, external storage URL revocation, deployed moderation acceptance checks, and backup restore drills. Existing tests often mock providers. Audited source need not equal deployed source.

## Vouch adoption and next work

[Vouch](https://github.com/mitchellh/vouch) uses explicit vouched/denounced records rather than an automatic numerical reputation score. Its consequences are project-defined. The requested policy is: public intake, Jacob-controlled trust, and Jacob-only write/merge access. Vouch never grants a collaborator role.

Implementation is complete and reviewed at commit `c568722bc74aa1776f21c6a0e37b6a3c0a360cf0` on `codex/vouch-contributor-policy`, in `/tmp/agent-notepad-vouch-20260906`, following [plan 001](001-vouch-contributor-policy.md). It adds seven files and passed 14 mocked safety tests, YAML parsing, immutable-action verification, and diff checks. The canonical list is seeded with Jacob. The workflow keeps issues/drafts open, reads trust from the canonical repository, checks the PR's actual head, and avoids running contributor code with privileged tokens. It will not auto-close, lock, comment on, or merge contributions. Hosted enforcement requires pushing the reviewed setup and configuring GitHub after publication or a plan upgrade. No repository publication or hosted mutation was performed in this audit.

The Vouch integration grants only content/PR read access plus commit-status write access. Its official pinned action installs a floating Nushell release internally. The setup guide records this supply-chain limitation, required strict up-to-date branches, non-atomic API/state changes, failed-refresh handling, and the conservative 256-open-PR ceiling. It is tested locally but has not been dispatched on GitHub; actionlint was unavailable. These are explicit validation/operational limits, not claims of live enforcement.

Recommended remediation order: A1; A2; A3/A4 together using shared visibility helpers; A7; A8; then A5. Configure G1/G2 as part of public launch. A6/A9 can follow as sandbox consistency fixes. Detailed implementation plans for application fixes were not created or executed; this report preserves the evidence and test requirements for selecting that work.

Considered and not reported as vulnerabilities: public agent self-registration/content contribution (intentional product behavior); public Convex deployment URLs (not credentials); authorized reviewer evidence access; WorkOS/Stripe test-only operation and Place sandbox-only finance; safe-fetch public DNS pinning; sanitized Markdown without raw HTML; authenticated backup encryption. Missing script-source restrictions in the current CSP, provider-native upload quotas, and unpinned Python transitive dependencies are additional defense-in-depth opportunities, not confirmed exploits from this review.

External-review triage: the narrowed CodeRabbit review completed with 28 general suggestions. Confirmed security-relevant follow-ups are A7–A9. Rejected widening `convex/billing.ts:19` to accept Stripe live keys because test-only billing is an explicit product safeguard. The suggested null guard in `convex/channels.ts:16` is already implied by `visibleSpace` checking the same parent in a consistent query snapshot. Malformed operator-configured trusted origins and provider error classification are diagnostic issues without a demonstrated attacker-controlled security effect. Screening input is validated at `convex/http.ts:234` before the internal material lookup. The proposed settlement rounding change is unnecessary: `lib/place.ts` already distributes integer remainders exactly. Uncaught transaction failures preserve atomic rollback; indiscriminately catching them after ledger writes could weaken consistency. Jury-roster growth is gated by administrator-approved owners and was classified as future scalability work. Stale search-row cleanup and other bounded-maintenance suggestions were not established as additional public disclosure or privilege bypasses in this audit; remaining correctness/performance suggestions are outside the security findings table.
