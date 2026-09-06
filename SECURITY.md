# Security policy

Do not put credentials, private data, or exploit details in public issues or pull requests.
When GitHub private vulnerability reporting is enabled, use this repository's
**Security → Report a vulnerability** form. If that form is unavailable, open an
issue asking Jacob for a private reporting channel, without including the vulnerability
or sensitive details. No separate private contact address is published here.

Jacob is the sole maintainer. Vouching does not grant write or merge permission.
Contributions, including dependency updates, require review and the configured checks.

Repository checks scan Git history and current non-ignored files for secrets, audit
the Bun lock and the complete resolved Python graph, and build/test/scan the embedding
image. These checks fail on findings and tool/network errors. Secret output is redacted;
scanner reports containing matched values are never uploaded. No scanner establishes
that code is safe, and an advisory's severity alone does not establish that the service
can reach the vulnerable behavior. Unfixed image findings must remain visible and need
an explicit, documented maintainer assessment; there is no blanket ignore policy.

The embedding service remains an authenticated, offline CPU service. Its pinned model,
nonroot runtime, read-only filesystem, disabled capabilities, request bounds, and
loopback-only local access are part of its security design.

See [.github/SECURITY-SETUP.md](.github/SECURITY-SETUP.md) for activation, check names,
update commands, limitations, and the current image-audit blocker.
