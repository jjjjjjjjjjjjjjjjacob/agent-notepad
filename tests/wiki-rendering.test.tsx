import { describe, it, expect } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"
import { Markdown } from "../components/features/markdown"
import { ArticleImage } from "../components/features/article-image"

describe("article evidence", () => {
  it("renders repeated source links as numbered references with unique return anchors", () => {
    const result = renderToStaticMarkup(
      <Markdown
        citations={[{ url: "https://example.org/evidence", title: "Evidence" }]}
      >
        {
          "A claim. [Evidence](https://example.org/evidence) Another. [Same](https://example.org/evidence) [Japan](/wiki/japan)"
        }
      </Markdown>
    )
    expect(result).toContain('href="#source-1"')
    expect(result).toContain('id="cite-1-1"')
    expect(result).toContain('id="cite-1-2"')
    expect(result).toContain('href="/wiki/japan"')
  })
  it("renders credited HTTPS photographs and prevents unsafe source protocols", () => {
    const image = renderToStaticMarkup(
      <Markdown>
        {
          '![Animals in a bath](https://upload.wikimedia.org/photo.jpg "Creator, CC BY 2.0")'
        }
      </Markdown>
    )
    expect(image).toContain('<img src="https://upload.wikimedia.org/photo.jpg"')
    expect(image).toContain('referrerPolicy="no-referrer"')
    expect(image).toContain("Creator, CC BY 2.0")
    expect(
      renderToStaticMarkup(
        <ArticleImage src="javascript:alert(1)" alt="Unsafe" />
      )
    ).not.toContain("<img")
    expect(
      renderToStaticMarkup(
        <ArticleImage src="//unsafe.test/image" alt="Unsafe" />
      )
    ).not.toContain("<img")
  })
})

describe("Wikipedia-style article layout", () => {
  it("renders an infobox with section headers, row headings, safe images and shared citations", () => {
    const result = renderToStaticMarkup(
      <Markdown
        variant="article"
        citations={[{ url: "https://example.org/source", title: "Evidence" }]}
      >
        {
          '```infobox\n# Subject\n\n![Subject photograph](https://example.org/photo.jpg "Creator, CC BY 4.0")\n\n## Classification\n\n| Property | Value |\n| --- | --- |\n| Family | [Related](/wiki/related) [Evidence](https://example.org/source) |\n\n## Background\n\nA summary.\n```\n\nA claim. [Evidence](https://example.org/source)\n\n## History\n\nDetails.'
        }
      </Markdown>
    )
    expect(result).toContain('class="markdown wiki-article ')
    expect(result).toContain('class="article-infobox" aria-label="Subject"')
    expect(result).toContain('data-size="infobox-title"')
    expect(result).toContain('data-size="infobox"')
    expect(result).toContain('<th scope="row">Family</th>')
    expect(result).toContain('href="/wiki/related"')
    expect(result).toContain('id="cite-1-1"')
    expect(result).toContain('id="cite-1-2"')
    expect(result).toContain('id="history"')
    expect(result).not.toContain('id="classification"')
    expect(result).not.toContain("language-infobox")
  })

  it("keeps infobox syntax inert outside article mode and does not execute HTML", () => {
    const body =
      "```infobox\n# Subject\n\n<script>alert(1)</script>\n\n![Unsafe](javascript:alert)\n```"
    expect(renderToStaticMarkup(<Markdown>{body}</Markdown>)).toContain(
      "language-infobox"
    )
    const result = renderToStaticMarkup(
      <Markdown variant="article">{body}</Markdown>
    )
    expect(result).not.toContain("<script>")
    expect(result).not.toContain("<img")
    expect(result).not.toContain('href="javascript:')
  })
})
