# Repository governance

## Authority and participation

Jacob (@jjjjjjjjjjjjjjjjacob) is the sole maintainer, repository writer, and
merger. Contributors may propose work, report bugs, open drafts, and participate
in review where repository access permits. A contribution or review does not
grant write access or commit the maintainer to accepting a change.

This policy concerns development of this repository. Moderation roles inside
the Agent Notepad product are separate and described in
[the moderation guide](docs/MODERATION.md).

## Vouch policy

Ready PRs must have an explicitly vouched author in the canonical
[`.github/VOUCHED.td`](.github/VOUCHED.td) on `main` before they are eligible
for merge. Jacob maintains that list through ordinary file edits. Removing an
entry removes trust; a leading `-` explicitly denounces an account.

Vouching reflects the maintainer's trust in a contributor's understanding and
care. It grants no repository permission, invitation, automatic acceptance, or
merge authority. Bots require an explicit vouch too. Unknown or denounced
accounts can still open issues and drafts; the policy automation does not close,
lock, or comment on them.

The trust check is separate from code review and validation. Changes to the
list inside a PR cannot self-vouch its author. A successful status alone does
not prove merge eligibility: Jacob must verify the actual author against
canonical trust and wait for a current successful refresh.

See [Vouch setup](.github/VOUCH-SETUP.md) for status races, strict up-to-date
requirements, hosted activation limits, and the exact evaluator/publisher
boundary. These documents and CODEOWNERS do not enable branch protection or
change repository visibility.

## Decisions and review

Routine fixes and documentation can proceed in focused PRs. Substantial changes
to product scope, architecture, dependencies, API compatibility, data models,
provider costs, or policy should begin with a short issue or draft describing:

- The concrete problem and intended behavior.
- Relevant alternatives and why the proposed approach fits the existing system.
- Compatibility, migration, operational impact, and validation.

Jacob makes the final decision. Record accepted behavior in the specification
and relevant guide in the same change. Keep unresolved ideas and implementation
plans labeled as such. Neither issue popularity nor an automated review is a
substitute for the maintainer's decision.

Resolve technical disagreements with reproducible examples, evidence, and
specific tradeoffs. Follow the [code of conduct](CODE_OF_CONDUCT.md). Review and
response times depend on maintainer availability; there is no promised schedule.

## Merge and release responsibility

Before merging, the maintainer checks scope, authorship/trust, current validation,
security findings, and any deployment or migration requirements. Dependencies,
workflow updates, and bot-authored changes follow the same policy; there is no
automatic merge exemption.

Releases and hosted configuration follow the
[production runbook](docs/LAUNCH-OPERATIONS.md). A merge can trigger configured
hosting automation, so compatibility and rollout requirements belong in review.
Changes to contributor trust, repository visibility/permissions, paid services,
and production data remain explicit maintainer decisions.

Security concerns use [SECURITY.md](SECURITY.md); security check activation and
required names live in [security setup](.github/SECURITY-SETUP.md). Governance
changes are reviewed file changes and do not silently grant new authority.
