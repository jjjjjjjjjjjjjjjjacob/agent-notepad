import assert from "node:assert/strict"
import test from "node:test"
import { parseChangeset, validateCoverage } from "./check-changesets.mjs"
import {
  checksPassed,
  releaseNotes,
  requiredChecks,
  validateDeployment,
} from "./github-release.mjs"

const manifest = { name: "agent-notepad", version: "0.0.0", private: true }
const empty = "---\n---\n\nCI-only change; no application version bump.\n"
const patch = '---\n"agent-notepad": patch\n---\n\nFix public search.\n'
const changelog = "# agent-notepad\n\n## 0.0.0\n\nInitial release.\n"

test("accepts release notes and explained non-release changesets", () => {
  assert.deepEqual(parseChangeset(patch), [
    { name: "agent-notepad", type: "patch" },
  ])
  assert.deepEqual(parseChangeset(empty), [])
  validateCoverage(manifest, [empty, patch])
})

test("rejects absent, malformed, unknown, duplicated and unexplained changesets", () => {
  assert.throws(() => validateCoverage(manifest, []))
  for (const contents of [
    "missing frontmatter",
    "---\n---\n",
    '---\n"agent-notepad": banana\n---\nwhy',
    '---\n"unknown": patch\n---\nwhy',
    '---\n"agent-notepad": patch\n"agent-notepad": minor\n---\nwhy',
  ])
    assert.throws(() => parseChangeset(contents))
})

test("preserves private packages and stable semver including the zero baseline", () => {
  validateCoverage(manifest, [empty])
  for (const version of ["v0.0.0", "01.0.0", "1.0", "1.0.0-rc.1"])
    assert.throws(() => validateCoverage({ ...manifest, version }, [empty]))
  assert.throws(() =>
    validateCoverage({ ...manifest, private: false }, [empty])
  )
})

test("requires a successful trusted production deployment at the expected SHA", () => {
  const deployment = {
    sha: "main-sha",
    environment: "Production",
    creator: { login: "vercel[bot]" },
  }
  const status = { state: "success", creator: { login: "vercel[bot]" } }
  validateDeployment(deployment, status, "main-sha")
  assert.throws(() => validateDeployment(deployment, status, "newer-main"))
  assert.throws(() =>
    validateDeployment(
      { ...deployment, environment: "Preview" },
      status,
      "main-sha"
    )
  )
  assert.throws(() =>
    validateDeployment(
      { ...deployment, creator: { login: "contributor" } },
      status,
      "main-sha"
    )
  )
  assert.throws(() =>
    validateDeployment(deployment, { ...status, state: "failure" }, "main-sha")
  )
  assert.throws(() =>
    validateDeployment(
      deployment,
      { ...status, creator: { login: "contributor" } },
      "main-sha"
    )
  )
})

test("requires all current check results from the GitHub Actions app", () => {
  const checks = requiredChecks.map((name, id) => ({
    name,
    id,
    app: { id: 15368 },
    conclusion: "success",
  }))
  assert.equal(checksPassed(checks), true)
  assert.equal(checksPassed(checks.slice(1)), false)
  assert.equal(
    checksPassed(checks.map((check) => ({ ...check, app: { id: 123 } }))),
    false
  )
  assert.equal(
    checksPassed([...checks, { ...checks[0], id: 100, conclusion: null }]),
    false
  )
  assert.equal(
    checksPassed([...checks, { ...checks[0], id: 100, conclusion: "failure" }]),
    false
  )
})

test("v0.0.0 releases exactly its own notes and rejects unversioned work", () => {
  assert.deepEqual(releaseNotes(manifest, changelog, [empty]), {
    tag: "v0.0.0",
    notes: "Initial release.",
  })
  const multiple = "## 0.0.1\n\nFix search.\n\n## 0.0.0\n\nInitial release.\n"
  assert.equal(
    releaseNotes({ ...manifest, version: "0.0.1" }, multiple, []).notes,
    "Fix search."
  )
  assert.throws(() => releaseNotes(manifest, changelog, [patch]))
  assert.throws(() => releaseNotes(manifest, "## 0.0.1\n\nOther version.", []))
  assert.throws(() => releaseNotes(manifest, "## 0.0.0\n", []))
})
