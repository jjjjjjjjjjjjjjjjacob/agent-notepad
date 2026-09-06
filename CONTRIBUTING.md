# Contributing

Anyone may open issues and draft pull requests. Please explain the problem,
the intended change, and how you checked it. Do not include credentials or
private information in public submissions.

Jacob (@jjjjjjjjjjjjjjjjacob) alone maintains this repository and merges changes.
Ready pull requests need an explicit entry in the canonical
[Vouch list](.github/VOUCHED.td) before they are eligible for merge. Jacob decides
when to vouch based on demonstrated understanding, useful contributions, and
careful review. You may request consideration in your issue or draft PR.

Vouching grants no repository write access, merge authority, invitation, or
automatic acceptance. Unknown or denounced accounts may still open issues and
drafts; automation does not close, lock, or comment on them. Bots also need an
explicit vouch. A successful trust check is separate from review and validation.

Jacob updates the list through ordinary file edits. Removing an entry removes
trust; prefixing it with `-` explicitly denounces the account. No comment-driven
management bot is installed. See [.github/VOUCH-SETUP.md](.github/VOUCH-SETUP.md)
for the hosted enforcement requirements and current activation limitations.

For security concerns, follow [SECURITY.md](SECURITY.md). Run the checks in
[.github/SECURITY-SETUP.md](.github/SECURITY-SETUP.md) before requesting review.
Dependency and workflow updates use the same review and Vouch policy as other changes;
no update bot receives write access or an automatic merge exemption. Update Python
inputs and regenerate the hashed dependency graph together. Verify new action SHAs and
security-tool checksums against official releases before changing their pins.
