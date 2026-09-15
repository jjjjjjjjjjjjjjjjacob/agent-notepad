import { execFileSync } from "node:child_process"
import { readFileSync, readdirSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { parseChangeset } from "./check-changesets.mjs"

const repository = "jjjjjjjjjjjjjjjjacob/agent-notepad"
export const requiredChecks = [
  "Application validation",
  "Secret and dependency scans",
  "Embedding image validation",
]

export function validateDeployment(deployment, status, sha) {
  if (
    deployment.sha !== sha ||
    deployment.environment !== "Production" ||
    deployment.creator?.login !== "vercel[bot]" ||
    status?.state !== "success" ||
    status.creator?.login !== "vercel[bot]"
  )
    throw new Error(
      "Release requires a successful Vercel Production deployment of the checked-out main commit."
    )
}

export function checksPassed(checks) {
  return requiredChecks.every((name) => {
    const matching = checks
      .filter((check) => check.name === name && check.app?.id === 15368)
      .sort((a, b) => b.id - a.id)
    return matching[0]?.conclusion === "success"
  })
}

export function releaseNotes(manifest, changelog, changesets) {
  if (
    manifest.name !== "agent-notepad" ||
    manifest.private !== true ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)
  )
    throw new Error("Invalid application release manifest.")
  if (changesets.some((contents) => parseChangeset(contents).length > 0))
    throw new Error(
      "Apply pending changesets in a reviewed version PR before releasing main."
    )
  const heading = `## ${manifest.version}`
  const lines = changelog.split(/\r?\n/)
  const start = lines.findIndex((line) => line.trim() === heading)
  if (start < 0)
    throw new Error("The current version is missing from CHANGELOG.md.")
  const next = lines.findIndex(
    (line, index) => index > start && line.startsWith("## ")
  )
  const notes = lines
    .slice(start + 1, next < 0 ? undefined : next)
    .join("\n")
    .trim()
  if (!notes) throw new Error("The current version needs release notes.")
  return { tag: `v${manifest.version}`, notes }
}

async function run() {
  if (process.env.GITHUB_REPOSITORY !== repository || !process.env.GH_TOKEN)
    throw new Error("Run through the application's GitHub release workflow.")
  const id = process.env.DEPLOYMENT_ID
  if (!/^\d+$/.test(id ?? ""))
    throw new Error("A numeric deployment ID is required.")
  const sha = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim()
  const api = async (path, method = "GET", body, allowMissing = false) => {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${process.env.GH_TOKEN}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      }
    )
    if (allowMissing && response.status === 404) return null
    if (!response.ok)
      throw new Error(`GitHub ${method} ${path} failed (${response.status}).`)
    return response.json()
  }
  const main = await api("branches/main")
  if (main.commit.sha !== sha)
    throw new Error("main advanced; rerun for its new deployment.")
  const deployment = await api(`deployments/${id}`)
  const statuses = await api(`deployments/${id}/statuses?per_page=1`)
  validateDeployment(deployment, statuses[0], sha)

  // Deployment completion and CI can arrive in either order. Bound the wait.
  let passed = false
  for (let attempt = 0; attempt < 24; attempt++) {
    const checks = await api(
      `commits/${sha}/check-runs?per_page=100&filter=latest`
    )
    if (checks.total_count > 100)
      throw new Error("Too many checks; inspect release readiness manually.")
    if (checksPassed(checks.check_runs)) {
      passed = true
      break
    }
    if (attempt < 23) await new Promise((done) => setTimeout(done, 10000))
  }
  if (!passed)
    throw new Error("Required GitHub Actions checks have not all passed.")

  const manifest = JSON.parse(readFileSync("package.json", "utf8"))
  const changesets = readdirSync(".changeset")
    .filter((name) => name.endsWith(".md") && name !== "README.md")
    .map((name) => readFileSync(`.changeset/${name}`, "utf8"))
  const { tag, notes } = releaseNotes(
    manifest,
    readFileSync("CHANGELOG.md", "utf8"),
    changesets
  )
  // Both the release and tag are idempotent; a version is never retagged.
  let ref = await api(`git/ref/tags/${tag}`, "GET", undefined, true)
  if (ref) {
    if (ref.object.type !== "tag")
      throw new Error("Expected an annotated release tag.")
    const existingTag = await api(`git/tags/${ref.object.sha}`)
    if (existingTag.object.sha !== sha) {
      const existingRelease = await api(
        `releases/tags/${tag}`,
        "GET",
        undefined,
        true
      )
      if (!existingRelease || existingRelease.draft)
        throw new Error(
          "An unreleased tag already points to a different commit."
        )
      console.log(`${tag} already released; no new version to publish.`)
      return
    }
  }
  execFileSync("bun", ["scripts/check-production.ts"], {
    stdio: "inherit",
    env: Object.fromEntries(
      Object.entries(process.env).filter(([key]) =>
        ["PATH", "HOME", "TMPDIR", "CI"].includes(key)
      )
    ),
  })
  if ((await api("branches/main")).commit.sha !== sha)
    throw new Error("main advanced during release checks.")
  if (!ref) {
    const annotation = await api("git/tags", "POST", {
      tag,
      message: tag,
      object: sha,
      type: "commit",
    })
    ref = await api("git/refs", "POST", {
      ref: `refs/tags/${tag}`,
      sha: annotation.sha,
    })
  }
  const release = await api(`releases/tags/${tag}`, "GET", undefined, true)
  if (release) {
    if (release.draft)
      throw new Error("A draft release exists; inspect it before publication.")
    console.log(`Release already exists: ${release.html_url}`)
    return
  }
  const created = await api("releases", "POST", {
    tag_name: tag,
    name: tag,
    body: notes,
    draft: false,
    prerelease: false,
    make_latest: "true",
  })
  console.log(`Published ${created.html_url}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
