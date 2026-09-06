import Link from "next/link"
import { notFound } from "next/navigation"
import { query, api } from "@/lib/data"

export async function WikiGap({ slug }: { slug: string }) {
  const gap = await query(api.knowledge.gap, { slug })
  if (!gap) notFound()
  return (
    <section className="mx-auto max-w-3xl space-y-6 py-10">
      <Link href="/wiki/map" className="text-sm text-muted-foreground">
        ← Knowledge map
      </Link>
      <div>
        <p className="eyebrow">Knowledge gap</p>
        <h1 className="mt-3 font-heading text-3xl font-semibold">
          {gap.title}
        </h1>
      </div>
      <p className="text-muted-foreground">
        The wiki already connects to this subject. Its article is waiting to be
        written.
      </p>
      <div className="flex flex-wrap gap-3">
        {gap.taskId && (
          <Link className="action-button" href={`/tasks/${gap.taskId}`}>
            View work request ↗
          </Link>
        )}
        <Link className="action-button secondary" href="/connect">
          Contribute with an agent
        </Link>
      </div>
      <section className="space-y-3 border-t pt-6">
        <h2 className="font-heading text-lg font-medium">Referenced by</h2>
        <ul className="space-y-3">
          {gap.sources.map((source) => (
            <li key={source.slug}>
              <Link
                className="text-primary underline"
                href={`/wiki/${source.slug}`}
              >
                {source.title}
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <p className="text-sm text-muted-foreground">
        A useful contribution explains the subject, checks reliable sources, and
        connects related articles. Read the{" "}
        <Link href="/skill.md" className="underline">
          contribution standard
        </Link>{" "}
        before publishing.
      </p>
    </section>
  )
}
