# Activating the contributor policy

These files prepare a policy; they do not change hosted settings. The repository
is currently private on a personal Free plan, where ruleset/branch protection
enforcement is unavailable. Jacob must separately authorize publication or an
appropriate plan upgrade before the required gate can be enforced.

1. Review and land these files on `main`. Keep Jacob as the only collaborator
   with write/maintain/admin access; do not add bot writers, deploy keys, PATs,
   auto-merge, or a bypass list. Leave Issues enabled and fork PRs available.
2. In Settings → Actions → General, retain read-only default token permissions,
   disable Actions creating/approving PRs, and require approval for workflows
   from **all outside collaborators**. Fork workflows must not receive secrets,
   deployment credentials, or write tokens. This `pull_request_target` policy
   workflow is privileged base-branch automation; outside-contributor approval
   is not a security barrier for it. It never executes PR code.
3. After public visibility/plan support is available, create active branch
   rulesets for `main` and `dev`: block deletion and force pushes; require a pull request;
   require status `Vouch / trusted contributor`; and **require branches to be up
   to date before merging**. Strict up-to-date checking is mandatory: a commit
   status cannot atomically bind itself to a future change of the trust list.
   Select the observed GitHub Actions source for the required status when the
   UI supports an expected source. Do not accept any arbitrary status source.
4. Require appropriate validation checks once they exist. Do not require a
   second person's approval or Jacob's self-review: GitHub prohibits approving
   one's own PR. CODEOWNERS requests Jacob's review; it does not itself enforce
   access, protect files, or prevent merges. Sole-writer collaborator settings
   and the active main ruleset provide the authority boundary.
5. Run **Vouch contributor policy → Run workflow → main** as Jacob for existing
   PRs. Verify the emitted status is attached to each PR's current head commit.
   Check a vouched author, unknown author, draft, and a trust removal using
   disposable PRs before relying on enforcement. Do not approve/run contributor
   code merely to test this policy. The hosted workflow was dispatched on
   September 6, 2026 and rejected draft PR #8 and unvouched Dependabot PRs as
   expected. Local tests cover trust removal and publication races; complete
   the remaining hosted cases before claiming full hosted enforcement.

Development PRs target default branch `dev`; release PRs target `main`. Both are
covered by Vouch, including shared-head decisions across those two targets.
The workflow reads trust only from canonical `main`; modifying the file in a
fork cannot self-vouch. Every main push, PR edit/base/state/head change, and manual recheck
refreshes all open PRs, setting heads pending before evaluation. Errors fail the
gate; upstream collaborator/bot exemptions cannot override the explicit list.
Only `github:login` or `-github:login` entries (optional trailing explanation)
are supported. Duplicate accounts and malformed/empty lists fail closed.

Heads are rechecked against main before and after status publication. If main
or the PR changes, the status becomes pending/error and another run is needed.
Require strict up-to-date branches and wait for the current refresh before
merging after a trust edit. API outages can prevent status updates; Jacob must
not merge while a refresh failed or is pending. More than 256 open PRs leaves
all heads pending until batching is extended. Shared head SHAs use the most
restrictive current PR author/draft decision. Closed PR events refresh remaining
PRs. GitHub may coalesce queued concurrency runs; each run refreshes current state.

Commit statuses bind to a SHA, not a unique PR identity. Although current
same-head PRs receive the most restrictive decision, event/API races remain:
a newly opened or changed PR can briefly inherit an earlier successful status.
Before merging, Jacob must verify the actual PR author against canonical trust
and wait for the current successful refresh. A status alone is neither identity
proof nor repository permission; Jacob remains the sole writer and merger.

Top-level actions are immutable official SHAs. Vouch v1.5.0 internally uses a
pinned setup-nu action but downloads the latest Nushell (`version: '*'`); that
interface has no version override. The evaluator has only `contents: read` and
`pull-requests: read`. This leaves runtime supply-chain and runner-resource risk,
but it cannot write commit statuses or repository contents.

The separate publisher grants `contents: read`, `pull-requests: read`, and
`statuses: write`. Official GitHub checkout, artifact download, and github-script
actions remain trusted with this token. Checkout is restricted to an immutable
canonical main snapshot with persisted credentials disabled. Evaluator artifacts
contain one bounded scalar status; they are never loaded as code. Publication
requires successful evaluation/artifact delivery, then independently re-reads the
canonical trust list and current PR/main/head/draft state before and after writing.
Upstream success cannot override the explicit canonical list. Missing, malformed,
oversized, or failed evaluation fails closed. Application CI uses separate jobs
with read-only credentials and never runs in this privileged workflow.

Local validation: `node --test .github/scripts/vouch-gate.test.cjs`.

Upstream: [Vouch v1.5.0](https://github.com/mitchellh/vouch/tree/d66fa29a64600490892131ad87597c30c91fcac4).
