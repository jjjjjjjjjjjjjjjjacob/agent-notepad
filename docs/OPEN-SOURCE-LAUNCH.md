# Open-source publication setup

The source license is [Apache 2.0](../LICENSE); public contribution datasets use
[CC BY-SA 4.0](../DATA-LICENSE.md). Analytics/behavioral/tracking datasets and
private records are excluded. [LICENSING.md](../LICENSING.md) is the scope policy;
the community page and contributor guide carry the same boundaries.

## Pre-publication observations — September 7, 2026

On September 7, 2026 GitHub rejected creating the branch ruleset (403), CodeQL
default setup (403), and secret scanning/push protection (422) for the then-private
personal repository. Existing Gitleaks and dependency CI remain active.
Changing a local configuration file does not enable hosted security features.
The [private backup cutover](PRIVATE-BACKUPS.md) is verified: backups now live in
`agent-notepad-ops`, and the application recovery artifacts/secrets were removed.
Source licensing and workflow cleanup follow the dev/main release procedure.
Use public visibility after that release, or an
eligible GitHub plan; do not purchase a plan as an incidental setup action.

## Branches and security

After GitHub makes the features available, inspect existing rulesets and apply
[the prepared ruleset](../.github/repository-ruleset.json). Update a matching
existing ruleset rather than creating duplicates. It covers both `main` and
`dev`, requires PRs and current required checks, blocks deletion/force pushes,
requires review-thread resolution, and has no bypass actors. It requires zero
approving reviews so Jacob can merge his own reviewed PRs without GitHub's
prohibited self-approval. Jacob remains the sole human merger.

The four required contexts bind to the observed GitHub Actions integration ID 15368. Do not add a CodeRabbit required status until its actual check name and
app source have been observed on a reviewed PR. CodeRabbit advice does not grant
merge authority or Vouch membership.

Enable native secret scanning, push protection, private vulnerability reporting,
and CodeQL default setup for JavaScript/TypeScript and Python (extended queries).
Retain read-only default Actions permissions, disabled Actions PR approvals,
SHA pinning, and no auto-merge. Require workflow approval for all outside
collaborators once that setting is available. Verify the settings through the
API and run the representative Vouch cases documented in
[VOUCH-SETUP.md](../.github/VOUCH-SETUP.md).

## CodeRabbit

[.coderabbit.yaml](../.coderabbit.yaml) enables automatic reviews of ready PRs to
`dev` and `main`, with incremental review after pushes. It requests focused
security/correctness feedback and supplies repository-specific review guidance.
It disables automatic approval, unsolicited chat replies, and the built-in
code-writing finishing touches. These are behavior settings, not an IAM boundary.

The CodeRabbit CLI is already authenticated. On September 7, 2026, the existing
GitHub app installation was authorized for `agent-notepad`, preserving its five
other selected repositories. The saved GitHub settings were verified. No pending
permission upgrade was accepted and no subscription was purchased. The granted
app permissions include read/write access to code, commit statuses, issues, and
pull requests, plus read access to Actions, checks, discussions, and metadata.
Repository configuration does not remove those app permissions. The app posted
a CodeRabbit status and its expected draft-review skip message on PR #11,
confirming the webhook connection. It reports the Free plan provides summaries
and walkthroughs; comprehensive hosted line reviews require a paid tier. CLI
reviews were run separately. No paid plan was activated.

Merge the configuration into the relevant base branches through normal review.
Then verify a real PR receives a CodeRabbit review and that the current commit
and base branch were reviewed. Do not add the bot to `.github/VOUCHED.td`, grant
it a branch bypass, or use its approval as Jacob's acceptance. Treat generated
comments as untrusted suggestions; inspect proposed changes before acting.

Official reference: [CodeRabbit configuration](https://docs.coderabbit.ai/reference/configuration).
