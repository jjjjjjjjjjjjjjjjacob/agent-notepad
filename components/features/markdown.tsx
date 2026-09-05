import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import rehypeSanitize from "rehype-sanitize"
import { Children, isValidElement, type ReactNode } from "react"
import { headingId } from "@/lib/content"
function textContent(node: ReactNode): string {
  return Children.toArray(node)
    .map((child) =>
      typeof child === "string" || typeof child === "number"
        ? String(child)
        : isValidElement<{ children?: ReactNode }>(child)
          ? textContent(child.props.children)
          : ""
    )
    .join("")
}
export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown max-w-[70ch] space-y-4 text-base leading-relaxed break-words [&_a]:text-primary [&_a]:underline [&_a]:underline-offset-4 dark:[&_a]:text-foreground [&_blockquote]:border-l-2 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_code]:rounded-sm [&_code]:bg-muted [&_code]:px-1 [&_code]:font-mono [&_code]:text-sm [&_h1]:mt-8 [&_h1]:font-heading [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:scroll-mt-6 [&_h2]:font-heading [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-6 [&_h3]:font-heading [&_h3]:text-lg [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-6 [&_pre]:overflow-x-auto [&_pre]:rounded-md [&_pre]:border [&_pre]:bg-muted [&_pre]:p-4 [&_table]:block [&_table]:overflow-x-auto [&_td]:border [&_td]:p-2 [&_th]:border [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-6">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeSanitize]}
        components={{
          pre: ({ children }) => (
            <pre tabIndex={0} aria-label="Code block">
              {children}
            </pre>
          ),
          h1: ({ children }) => (
            <h2 id={headingId(textContent(children))}>{children}</h2>
          ),
          h2: ({ children }) => (
            <h2 id={headingId(textContent(children))}>{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 id={headingId(textContent(children))}>{children}</h3>
          ),
          h4: ({ children }) => (
            <h4 id={headingId(textContent(children))}>{children}</h4>
          ),
          a: ({ href, children }) => (
            <a href={href} rel="nofollow ugc noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="text-sm text-muted-foreground">
              [Image: {alt || "attachment"}]
            </span>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  )
}

// Use the same Markdown parser and heading IDs as the article itself.
export function MarkdownContents({ children }: { children: string }) {
  const heading = ({ children }: { children?: ReactNode }) => (
    <a href={`#${headingId(textContent(children))}`}>{textContent(children)}</a>
  )
  const hidden = () => null
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeSanitize]}
      components={{
        h1: heading,
        h2: heading,
        h3: heading,
        h4: hidden,
        h5: hidden,
        h6: hidden,
        p: hidden,
        pre: hidden,
        ul: hidden,
        ol: hidden,
        blockquote: hidden,
        table: hidden,
        hr: hidden,
      }}
    >
      {children}
    </ReactMarkdown>
  )
}
