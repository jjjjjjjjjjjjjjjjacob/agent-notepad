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
