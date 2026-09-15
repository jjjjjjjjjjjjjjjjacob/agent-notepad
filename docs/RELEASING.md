# Versions and GitHub Releases

Agent Notepad follows The Market's Changesets model: each PR declares its semver
impact, Changesets generates the version/changelog, and successful production
deployments receive annotated tags and GitHub Releases. This repository has one
private package, `agent-notepad`, with the initial version **0.0.0**. It is not
published to npm. The REST `/api/v1` contract version is separate from the
application's release version.

## Contributions

Run `bun run changeset`, select `agent-notepad`, and choose `patch`, `minor`, or
`major`. Commit the generated `.changeset/*.md` file with the change. For work
with no release impact, use `bun run changeset --empty` and add a rationale.
CI checks every PR targeting `dev` for a new valid entry; existing entries do
not satisfy a new PR. See [Changesets](../.changeset/README.md).

```sh
bun run changeset:status
bun run changeset:check -- --since origin/dev
```

## Prepare a release

1. Start a version-preparation branch from current `dev`.
2. Run `bun run changeset:version` with a read-only `GITHUB_TOKEN` available for
   GitHub changelog attribution, then `bun install --lockfile-only --ignore-scripts`.
   Review `package.json`, `bun.lock`, `CHANGELOG.md`, and consumed changesets.
3. Add an explained empty changeset for this version-preparation PR. Commit the
   generated version changes and open a PR into `dev`. Check the diff, normal
   CI, and Vouch. Do not commit a GitHub token or bypass branch protections.
4. Jacob merges the version-preparation PR and promotes reviewed `dev` to `main`
   through a release PR. Recheck that no unapplied release changesets remain.
   Version changes precede deployment so the release tag identifies the exact
   deployed code. Unlike The Market's direct bot version pushes, all branch
   changes here retain the normal PR and sole-merger policy.
5. Vercel deploys `main` to production. The GitHub release workflow verifies a
   successful Vercel `Production` deployment at current `main`, the latest three
   required CI checks from GitHub Actions, and production health. It then creates
   an annotated `vX.Y.Z` tag and a GitHub Release from that version's changelog.

The initial `v0.0.0` baseline is committed explicitly with an empty bootstrap
changeset. It must not be incremented merely to initialize Changesets.

## Recovery and permissions

The release job uses the repository's short-lived `GITHUB_TOKEN`, with content
write and check/deployment read access. It checks out fixed `main`, never an
event-supplied ref, and does not need an npm token, release app, production
credential, or branch bypass. Default workflow permissions remain read-only.

If CI completes after the deployment, the job waits for at most four minutes.
Failures stop before creating a tag. After resolving a failure, Jacob can
dispatch **GitHub release** from `main` using the numeric GitHub deployment ID
for the successful current production commit. A newer `main` commit requires
its own successful deployment. Never retarget an existing release tag.

Repeated delivery does not duplicate tags or Releases. If a successful version
was already released, a subsequent deployment with the same version leaves that
release unchanged. If tag creation succeeds but release creation fails, retrying
the same deployed commit creates the missing Release. Conflicting or draft
releases require inspection. `bun run changeset:tag` remains available to create
local annotated tags, but the workflow publishes through GitHub's API and never
pushes a branch.

Keep [production operations](LAUNCH-OPERATIONS.md) and the
[private backup repository](PRIVATE-BACKUPS.md) separate from public releases.
Release assets contain no database dumps or recovery artifacts.
