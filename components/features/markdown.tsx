import ReactMarkdown, { type Components } from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { Children, isValidElement, type ReactNode } from "react"
import { articleHeadings } from "@/lib/article-markdown"
import { SectionHeading } from "@/components/design-system/headings"
import { ArticleImage } from "./article-image"

export function Markdown({
  children,
  citations = [],
  variant = "default",
}: {
  children: string
  citations?: { url: string; title: string }[]
  variant?: "default" | "article"
}) {
  const seen = new Map<number, number>()
  const headings = new Map(
    articleHeadings(children).map((heading) => [heading.offset, heading.id])
  )
  const heading = (level: 2 | 3 | 4 | 5 | 6): Components["h2"] =>
    function ArticleSection({ children, node }) {
      const id = headings.get(node?.position?.start.offset ?? -1)
      if (variant === "article") {
        return (
          <SectionHeading
            as={`h${level}`}
            id={id}
            title={children}
            size={level === 2 ? "article" : "article-subsection"}
          />
        )
      }
      const Tag = `h${level}` as const
      return <Tag id={id}>{children}</Tag>
    }
  const components: Components = {
    pre: ({ children, node }) => {
      const code = node?.children[0]
      if (
        variant === "article" &&
        code?.type === "element" &&
        code.tagName === "code" &&
        code.properties.className instanceof Array &&
        code.properties.className.includes("language-infobox")
      ) {
        const body = code.children
          .flatMap((child) => (child.type === "text" ? [child.value] : []))
          .join("")
        const title = articleHeadings(body)[0]?.title || "Article facts"
        const band = (title: ReactNode, main = false) => (
          <SectionHeading
            as={main ? "h2" : "h3"}
            title={title}
            size={main ? "infobox-title" : "infobox"}
          />
        )
        return (
          <aside className="article-infobox" aria-label={title}>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                ...components,
                // Infoboxes contain ordinary Markdown; nested fences remain code.
                pre: ({ children }) => (
                  <pre tabIndex={0} aria-label="Code block">
                    {children}
                  </pre>
                ),
                h1: ({ children }) => band(children, true),
                h2: ({ children }) => band(children),
                h3: ({ children }) => band(children),
                h4: ({ children }) => band(children),
                h5: ({ children }) => band(children),
                h6: ({ children }) => band(children),
                tr: ({ children }) => {
                  let first = true
                  return (
                    <tr>
                      {Children.map(children, (child) => {
                        if (
                          !isValidElement<{ children?: ReactNode }>(child) ||
                          child.type !== "td"
                        )
                          return child
                        if (!first) return child
                        first = false
                        return <th scope="row">{child.props.children}</th>
                      })}
                    </tr>
                  )
                },
              }}
            >
              {body}
            </ReactMarkdown>
          </aside>
        )
      }
      return (
        <pre tabIndex={0} aria-label="Code block">
          {children}
        </pre>
      )
    },
    h1: heading(2),
    h2: heading(2),
    h3: heading(3),
    h4: heading(4),
    h5: heading(5),
    h6: heading(6),
    a: ({ href, children }) => {
      const index = citations.findIndex((citation) => citation.url === href)
      if (index >= 0) {
        const occurrence = (seen.get(index) ?? 0) + 1
        seen.set(index, occurrence)
        return (
          <sup className="citation-ref" id={`cite-${index + 1}-${occurrence}`}>
            <a
              href={`#source-${index + 1}`}
              title={citations[index].title}
              aria-label={`Source ${index + 1}: ${citations[index].title}`}
            >
              [{index + 1}]
            </a>
          </sup>
        )
      }
      return (
        <a href={href} rel="nofollow ugc noopener noreferrer">
          {children}
        </a>
      )
    },
    img: ({ src, alt, title }) => (
      <ArticleImage
        src={typeof src === "string" ? src : undefined}
        alt={alt}
        title={title}
      />
    ),
  }
  return (
    <div
      className={`markdown ${variant === "article" ? "wiki-article" : ""} max-w-[70ch] space-y-4 text-base leading-relaxed break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 dark:[&_a]:text-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm [&_h1]:mt-8 [&_h1]:font-heading [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:scroll-mt-6 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:font-heading [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-4 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6`}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={components}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}
