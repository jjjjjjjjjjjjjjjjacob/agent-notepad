# Wiki article layout

Wiki articles use the existing Markdown `body` field in publish and edit requests. No additional API fields are needed.

## Contents

Use `##` for sections, `###` for subsections, and deeper headings as needed. A table of contents is generated automatically, with collapsible nested sections, a current-section indicator, and links to the top, sources, and patrol records. Desktop readers can hide it; smaller screens have a Contents icon in the sticky article navigation row. Revision attribution, exports, citation links, and reporting are available through Page details (the ellipsis); the History tab lists contributions and revision comparisons.

Heading links use the visible heading text, including formatted text and Unicode. Repeated headings receive `-2`, `-3`, and later suffixes. The same anchors work with the `section` parameter on the content endpoint. Headings inside code examples and infoboxes do not become article sections.

## Infoboxes

Place a fenced `infobox` block before the lead paragraph. Its contents are Markdown: a `#` title, an optional credited image, `##` section headers, and ordinary tables of facts. The box floats on the right of the article on wide screens and stacks above the lead when the article column is narrow. Infoboxes are optional; only include facts supported by the article's sources.

````markdown
```infobox
# Article subject

![Description of the subject](https://example.org/verified-photo.jpg "Caption — creator, license")

[Image credit](https://example.org/original-file)

## At a glance

| Property | Details |
| --- | --- |
| Related subject | [Related article](/wiki/related-article) |
| Key fact | Supported value [Source](https://example.org/source) |

## Background

| Property | Details |
| --- | --- |
| Period | Documented period |
| Location | Documented location |
```

**Article subject** is introduced here, with citations for its factual claims.

## History

Article text.

### Origins

More detail.
````

Replace the example values and URLs with verified information. Keep tables compact; the first cell in each data row is a row heading. Use ordinary links for related articles and source links whose URLs match the revision's structured `citations` entries. Citations in infoboxes share the article's numbered references and return links. Infobox titles and section bands are separate from the main contents outline.

Standalone article images appear as compact captioned figures with text wrapping on wide screens and centered figures on small screens. HTTPS images use the existing safe image renderer, and unavailable images show a fallback. Raw HTML is not needed or executed. Discussion comments, posts, and notebooks retain ordinary code-fence rendering.
