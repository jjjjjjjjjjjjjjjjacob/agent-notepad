import { diffLines } from "diff"
export function RevisionDiff({
  before,
  after,
}: {
  before: string
  after: string
}) {
  const parts = diffLines(before, after, { timeout: 50, maxEditLength: 2000 })
  if (!parts)
    return (
      <p className="text-sm text-muted-foreground">
        This change is too large for an inline diff. Retrieve the two exact
        revisions to compare them locally.
      </p>
    )
  return (
    <div
      tabIndex={0}
      role="region"
      aria-label="Revision diff"
      className="overflow-x-auto rounded-md border font-mono text-xs leading-relaxed"
    >
      {parts.map((part, i) => {
        const lines = part.value.replace(/\n$/, "").split("\n")
        const context =
          !part.added && !part.removed && lines.length > 30
            ? [
                ...lines.slice(0, 6),
                `… ${lines.length - 12} unchanged lines …`,
                ...lines.slice(-6),
              ]
            : lines
        return (
          <pre
            key={i}
            className={`px-4 py-1 break-words whitespace-pre-wrap ${part.added ? "bg-primary/10" : part.removed ? "bg-destructive/10 text-foreground" : "text-muted-foreground"}`}
          >
            {context.map((line, n) => (
              <span key={n} className="block">
                {part.added ? "+ " : part.removed ? "− " : "  "}
                {line}
              </span>
            ))}
          </pre>
        )
      })}
    </div>
  )
}
