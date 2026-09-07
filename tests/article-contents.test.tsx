import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { articleContents, articleHeadings } from "../lib/article-markdown"
import { sectionBody } from "../lib/content"
import { wikiLinks, markdownText } from "../lib/wiki-content"
import { Markdown } from "../components/features/markdown"

const body = `An introduction.

## **Ecology** & ~~old~~ habits

### Diet

Details.

##### Deep detail

Details.

## Diet

A different section.

## Diet-2

## 日本

Title with setext
-----------------

## !!!

## Article sources

\`\`\`markdown
## Not a section
\`\`\`

\`\`\`infobox
# Subject
## Classification
| Fact | Value |
| --- | --- |
| Location | [Japan](/wiki/japan) |
\`\`\`
`

describe("article section anchors", () => {
  it("builds a nested outline with skipped depths and ignores code and infobox headings", () => {
    const contents = articleContents(body)
    expect(contents[0]).toMatchObject({
      title: "Ecology & old habits",
      children: [{ title: "Diet", children: [{ title: "Deep detail" }] }],
    })
    const headings = articleHeadings(body)
    expect(headings.map((heading) => heading.id)).toEqual([
      "ecology-old-habits",
      "diet",
      "deep-detail",
      "diet-2",
      "diet-2-2",
      "日本",
      "title-with-setext",
      "section",
      "article-sources-2",
    ])
  })

  it("matches every contents anchor to a unique rendered heading and retrievable section", () => {
    const html = renderToStaticMarkup(
      <Markdown variant="article">{body}</Markdown>
    )
    for (const heading of articleHeadings(body)) {
      expect(html.split(`id="${heading.id}"`)).toHaveLength(2)
      expect(sectionBody(body, heading.id)).not.toBeNull()
    }
    expect(sectionBody(body, "diet-2")).toBe("## Diet\n\nA different section.")
    expect(sectionBody(body, "title-with-setext")).toBe(
      "Title with setext\n-----------------"
    )
    expect(sectionBody(body, "classification")).toBeNull()
  })

  it("counts infobox facts and wiki links as content while ignoring ordinary code examples", () => {
    expect(wikiLinks(body)).toEqual([{ slug: "japan", title: "Japan" }])
    expect(markdownText(body)).toContain("Location Japan")
    expect(wikiLinks("```markdown\n[Example](/wiki/example)\n```")).toEqual([])
  })
})
