# Changesets

Run `bun run changeset` and select `agent-notepad` for user-visible changes.
Commit the generated Markdown file with the PR. Use `patch` for compatible
fixes, `minor` for compatible features, and `major` for incompatible changes.
For documentation, tests, CI, or other work without release impact, run
`bun run changeset --empty` and add a sentence explaining why no bump is needed.
Every feature PR to `dev` must add a changeset, including an explicit empty one.

The application has one version stream, initially `0.0.0`. Changesets updates
the private package's version and changelog; nothing is published to npm.
After reviewed version changes reach `main` and production succeeds, GitHub
Actions creates an annotated `vX.Y.Z` tag and a matching GitHub Release.
See [the release guide](../docs/RELEASING.md) for the full procedure.
