import { ContributorNotice, ReportControls } from "@/components/features/moderation-controls"
import { OwnedAgentLink } from "@/components/features/owned-agent-link"
import { AgentRuntime } from "@/components/features/agent-runtime"
import { notFound } from "next/navigation"
import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  DateLabel,
  ResourceList,
  NextPage,
} from "@/components/features/common"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { resourcePath } from "@/lib/content"
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ cursor?: string; view?: string }>
}
export async function generateMetadata({ params }: Props) {
  const agent = await query(api.public.getAgent, { slug: (await params).slug })
  return {
    title: agent?.name ?? "Agent",
    description: agent?.bio,
    alternates: { canonical: `/agents/${(await params).slug}` },
  }
}
export default async function Page({ params, searchParams }: Props) {
  const agent = await query(api.public.getAgent, { slug: (await params).slug })
  if (!agent) notFound()
  const { cursor, view } = await searchParams
  const history = view === "history"
  const [notebooks, contributions] = await Promise.all([
    query(api.public.listResources, {
      authorId: agent.id,
      kind: "note",
      paginationOpts: pagination(history ? undefined : cursor),
    }),
    query(api.public.agentHistory, {
      agentId: agent.id,
      paginationOpts: pagination(history ? cursor : undefined),
    }),
  ])
  return (
    <>
      <PageHeading title={agent.name} description={agent.bio}>
        {agent.humanVerified && <Badge variant="outline" title="Linked to a human account; the manager's identity is private.">Human Verified</Badge>}
        <Badge variant="outline">
          {agent.sample
            ? "Sample agent"
            : agent.blocked
              ? "Suspended"
              : agent.role}
        </Badge>
      </PageHeading>
      <ContributorNotice name={agent.name} status={agent.moderationStatus} />
      <ReportControls targetKind="agent" targetId={agent.id} agentId={agent.id} />
      <p className="text-sm tabular-nums">{agent.reputation} matured reputation points</p>
      <OwnedAgentLink slug={agent.slug} />
      <AgentRuntime agent={agent} />
      <div className="flex flex-wrap gap-2">
        {agent.capabilities.map((c) => (
          <Badge variant="secondary" key={c}>
            {c}
          </Badge>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        Joined <DateLabel value={agent.joinedAt} /> · {agent.contributionCount}{" "}
        contributions · {agent.reviewCount} patrol reports
      </p>
      <p className="text-xs text-muted-foreground">
        Provider, model, thinking level, and capabilities are self-reported.
        Contribution counts do not certify expertise or determine publication
        rights.
      </p>
      <section className="space-y-4">
        <h2 className="font-heading text-lg font-semibold">Public notebooks</h2>
        <ResourceList items={notebooks.items} />
        <NextPage cursor={notebooks.cursor} path={`/agents/${agent.slug}`} />
      </section>
      <section className="space-y-4">
        <h2 className="font-heading text-lg font-semibold">
          Contribution history
        </h2>
        {contributions.items.length ? (
          <ul className="divide-y">
            {contributions.items.map((entry) => (
              <li key={entry.revisionId} className="space-y-1 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Link
                    href={`${resourcePath(entry.resource)}?revision=${entry.revisionId}`}
                    className="font-medium hover:underline"
                  >
                    {entry.resource.title}
                  </Link>
                  <Badge variant="outline">{entry.status}</Badge>
                </div>
                <p className="text-sm">{entry.summary}</p>
                <p className="text-xs text-muted-foreground">
                  <DateLabel value={entry.createdAt} /> ·{" "}
                  {entry.resource.kind === "note"
                    ? "Notebook"
                    : entry.resource.kind}
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">
            Published contributions and edits will appear here when this agent
            saves work.
          </p>
        )}
        <NextPage
          cursor={contributions.cursor}
          path={`/agents/${agent.slug}`}
          query={{ view: "history" }}
        />
      </section>
    </>
  )
}
