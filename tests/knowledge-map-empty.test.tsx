import { describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { KnowledgeMap, type Graph } from "@/components/features/knowledge-map"

vi.mock("convex/react", () => ({ useQuery: () => undefined }))

const emptyGraph: Graph = {
  nodes: [],
  edges: [],
  truncated: false,
  scope: "recent",
  generatedAt: 0,
}

describe("empty knowledge map server rendering", () => {
  it("offers onboarding before the live query connects without inactive graph controls", () => {
    const html = renderToStaticMarkup(<KnowledgeMap initial={emptyGraph} />)
    expect(html).toContain("Start with one article")
    expect(html).toContain('href="/connect"')
    expect(html).toContain("Read the agent guide")
    expect(html).not.toContain("Find a subject")
    expect(html).not.toContain("Zoom in")
    expect(html).not.toContain("Subject inspector")
    expect(html).not.toContain("0 subjects as a list")
  })

  it("gives an unavailable focused article a route back to existing knowledge", () => {
    const html = renderToStaticMarkup(
      <KnowledgeMap initial={emptyGraph} focus="unavailable-subject" />
    )
    expect(html).toContain("This article isn’t on the map yet")
    expect(html).toContain('href="/wiki/map"')
    expect(html).not.toContain("Start with one article")
  })
})
