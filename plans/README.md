# Security audit and contributor policy

Audit baseline: `e1dad6e`, September 5, 2026. Existing application/UI edits are preserved.

- [Final hardening review](security-review-2026-09-06.md): current results, contributor policy, residual risks and public-launch requirements.
- [Historical security audit](security-audit-2026-09-05.md): original findings and evidence before hardening.
- [Vouch contributor policy](001-vouch-contributor-policy.md): user-requested adoption of Mitchell Hashimoto's trust system, preserving public issues/drafts and Jacob-only write/merge authority.

| Plan | Status | Dependencies |
| --- | --- | --- |
| 001 — Vouch contributor policy | DONE, reviewed at `c568722`; not pushed or active on GitHub | Hosted enforcement requires reviewed files on GitHub and public visibility or an eligible plan |

Vouch worktree: `/tmp/agent-notepad-vouch-20260906`, branch `codex/vouch-contributor-policy`. Seven new files only; 14 safety tests passed, YAML parsed, action SHAs verified, diff checks passed. The original application checkout and existing user edits were not changed. See the worktree's `.github/VOUCH-SETUP.md` for activation requirements.

The user selected comprehensive security hardening on September 6. Application fixes have been executed in isolated worktrees and independently reviewed; the original checkout and hosted visibility remain unchanged.

| Plan | Status | Dependencies |
| --- | --- | --- |
| 002 — Moderation evidence boundaries | DONE, reviewed at `3978957` | None; local only |
| 003 — Public knowledge visibility | DONE, reviewed at `bd1ff24` (includes002) | 002 DONE; local only |
| 004 — Retired provider authentication budget | Historical; integration subsequently removed | None |
| 005 — Bounded governance jobs | DONE, reviewed at `1f462d6` | None; local only |
| 006 — Sandbox wallet safety | DONE, reviewed at `7dffea2` | None; local only |
| 007 — Security automation and supply chain | DONE, reviewed at `030d7c2`;21 dated residual image findings | 001 DONE; local only |
| 008 — Bounded case authorship | DONE, reviewed at `9f65305` | 002 DONE; local only |
| 009 — Integrate and verify security hardening | DONE, reviewed at `21725f6`; clean local integration branch | 001–008 DONE; final review pending |

Final application verification passed at `967d16d`: 312 tests plus one existing skip, 24 browser tests, typecheck/lint and an optimized build. Final CI verification also passed: 31 Node/Vouch tests, live staged-secret fixtures, final history/index/worktree scan and the actual hardened image runner with archive-bypass/missing-cache guards. Full external review returned five independently triaged leads; its narrow scanner rerun was rate-limited. All nine local plans are DONE. The audit remains the historical baseline finding record; DONE means reviewed local implementation, not deployed protection.

Hosted hardening verified September 6: dependency vulnerability alerts enabled (GET returns 204); Actions now requires full commit SHA pinning (`sha_pinning_required: true`). Default token permissions remain read-only; workflow PR approval remains disabled. Repository remains private, Jacob sole writer, no visibility change.

Plan004 reviewed in `/tmp/agent-notepad-security-workos-20260906`, branch `codex/security-workos-budget`. Primary reviewed all five changed files and reran typecheck, lint, both WorkOS suites (23 passing tests), and diff/scope checks successfully. SDK/JWKS state is reused; all live authorization checks remain. A durable shared cap limits provider work but can temporarily be exhausted by attackers; this tradeoff is documented. No application deployment yet.

Plan002 reviewed in `/tmp/agent-notepad-security-moderation-20260906`, branch `codex/security-moderation-boundaries`. Primary reviewed all 17 changed files and meaningful boundary tests, and independently reran typecheck, lint, five test files (85 passing tests), and diff checks. Quarantined task derivatives now retain source provenance; participant evidence is explicitly separated from forensic material. Long-history case intake is tracked separately in008; graph task integration remains in003.

Final integration: `/tmp/agent-notepad-security-integration-20260906`, branch `codex/security-hardening`, commit `21725f66b60f6912fbca0e18a176c2c2be9ee06b`. See [the final review](security-review-2026-09-06.md) for residual risks and hosted activation. No merge, push, publication or deployment occurred; main and origin/main remain e1dad6e.

Considered during final review: removing the SHA-bound Vouch gate would not strengthen sole-writer authority, so its event race is documented; unused unexpired exact image exceptions do not widen accepted findings; missing-revision error formatting is diagnostic cleanup. FastEmbed's unsafe archive helper is a dormant dependency hazard bypassed by the pinned-model loader, now guarded in CI. The scanner's staged-index gap was confirmed and fixed.
