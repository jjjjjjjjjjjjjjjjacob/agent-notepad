import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"

// The Market's explicit changeset/empty-changeset policy, adapted to one package.
export function parseChangeset(contents) {
  const lines = contents.replace(/^\uFEFF/, "").split(/\r?\n/)
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---")
  if (lines[0]?.trim() !== "---" || end < 0)
    throw new Error("Changesets require opening and closing --- frontmatter.")
  if (
    !lines
      .slice(end + 1)
      .join("\n")
      .trim()
  )
    throw new Error("Explain the change or why no version bump is needed.")
  const releases = []
  for (const line of lines.slice(1, end).map((line) => line.trim())) {
    if (!line || line.startsWith("#")) continue
    const match = line.match(
      /^(?:"([^"]+)"|'([^']+)'|([^:#][^:]*?)):\s*(major|minor|patch)\s*$/
    )
    if (!match) throw new Error("Invalid changeset release entry.")
    const name = (match[1] ?? match[2] ?? match[3]).trim()
    if (name !== "agent-notepad" || releases.length)
      throw new Error("A changeset may name agent-notepad once, or be empty.")
    releases.push({ name, type: match[4] })
  }
  return releases
}

export function validateCoverage(manifest, changesets) {
  if (manifest.name !== "agent-notepad" || manifest.private !== true)
    throw new Error(
      "Keep the agent-notepad package private (no npm publication)."
    )
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version))
    throw new Error("The package must have a stable x.y.z version.")
  if (!changesets.length)
    throw new Error(
      "Add a new changeset; use an explained empty changeset for non-release work."
    )
  for (const contents of changesets) parseChangeset(contents)
}

function run() {
  const args = process.argv.slice(2).filter((arg) => arg !== "--")
  if (args.length !== 2 || args[0] !== "--since" || args[1].startsWith("-"))
    throw new Error("Usage: bun run changeset:check -- --since <git-ref>")
  // Resolve first so ref input is never interpreted as a diff option or path.
  const base = execFileSync(
    "git",
    ["rev-parse", "--verify", `${args[1]}^{commit}`],
    { encoding: "utf8" }
  ).trim()
  const files = execFileSync(
    "git",
    [
      "diff",
      "--name-only",
      "-z",
      "--diff-filter=A",
      `${base}...HEAD`,
      "--",
      ".changeset",
    ],
    { encoding: "utf8" }
  )
    .split("\0")
    .filter(
      (file) =>
        /^\.changeset\/[^/]+\.md$/.test(file) && file !== ".changeset/README.md"
    )
  // Read committed blobs: uncommitted edits must not make CI coverage appear valid.
  const changesets = files.map((file) =>
    execFileSync("git", ["show", `HEAD:${file}`], { encoding: "utf8" })
  )
  validateCoverage(JSON.parse(readFileSync("package.json", "utf8")), changesets)
  execFileSync("bun", ["run", "changeset:status", "--since", base], {
    stdio: "inherit",
  })
  process.stdout.write("Changeset coverage passed.\n")
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    run()
  } catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
