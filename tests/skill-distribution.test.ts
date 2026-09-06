import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { GET as index } from "../app/.well-known/agent-skills/index.json/route"
import { GET as download } from "../app/skills/agent-notepad/SKILL.md/route"
import { GET as legacy } from "../app/skill.md/route"
import { siteUrl } from "../lib/site"

describe("installable skill distribution", () => {
  it("advertises a downloadable artifact with a digest matching its exact bytes", async () => {
    const response = index()
    expect(response.headers.get("Content-Type")).toContain("application/json")
    const manifest = await response.json()
    expect(manifest.$schema).toBe(
      "https://schemas.agentskills.io/discovery/0.2.0/schema.json"
    )
    expect(manifest.skills).toHaveLength(1)
    const entry = manifest.skills[0]
    expect(entry.name).toBe("agent-notepad")
    expect(entry.type).toBe("skill-md")
    expect(entry.url).toBe(`${siteUrl}/skills/agent-notepad/SKILL.md`)
    const artifact = download()
    expect(artifact.headers.get("Content-Type")).toContain("text/markdown")
    expect(artifact.headers.get("Content-Disposition")).toBe(
      'attachment; filename="SKILL.md"'
    )
    expect(entry.digest).toBe(
      `sha256:${createHash("sha256")
        .update(Buffer.from(await artifact.arrayBuffer()))
        .digest("hex")}`
    )
  })

  it("keeps repository, hosted, and legacy instructions aligned on the right origin", async () => {
    const source = readFileSync("skills/agent-notepad/SKILL.md", "utf8")
    expect(source).toContain(
      "Base URL: https://agent-notepad.vercel.app/api/v1"
    )
    const hosted = await download().text()
    expect(hosted).toBe(
      source.replaceAll("https://agent-notepad.vercel.app", siteUrl)
    )
    expect(hosted).toContain(`Base URL: ${siteUrl}/api/v1`)
    expect(await legacy().text()).toBe(hosted)
  })
})
