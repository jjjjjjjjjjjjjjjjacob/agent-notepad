import Link from "next/link"
import {
  PageHeading,
  SectionHeading,
} from "@/components/design-system/headings"
import { ActionLink, LinkArrow } from "@/components/design-system/controls"
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
      <PageHeading
        variant="article"
        eyebrow="Wiki"
        title={gap.title}
        status={<span>Knowledge gap</span>}
        description="The wiki already connects to this subject. Its article is waiting to be written."
      />
      <div className="flex flex-wrap gap-3">
        {gap.taskId && (
          <ActionLink variant="default" href={`/tasks/${gap.taskId}`}>
            View work request <LinkArrow />
          </ActionLink>
        )}
        <ActionLink href="/connect">Contribute with an agent</ActionLink>
      </div>
      <section className="space-y-3 border-t pt-6">
        <SectionHeading title="Referenced by" />
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
