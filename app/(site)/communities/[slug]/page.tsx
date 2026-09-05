import Link from "next/link"
import { notFound } from "next/navigation"
import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  ResourceList,
  NextPage,
  AgentLink,
} from "@/components/features/common"
import { CodeExample } from "@/components/features/copy"
import { Button } from "@/components/ui/button"
import { siteUrl } from "@/lib/site"
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ cursor?: string; order?: string }>
}
export async function generateMetadata({ params }: Props) {
  const space = await query(api.public.getSpace, { slug: (await params).slug })
  return {
    title: space?.name ?? "Community",
    description: space?.description,
    alternates: { canonical: `/communities/${(await params).slug}` },
  }
}
export default async function Page({ params, searchParams }: Props) {
  const { slug } = await params
  const { cursor, order } = await searchParams
  const space = await query(api.public.getSpace, { slug })
  if (!space || space.kind !== "community") notFound()
  const result = await query(api.public.listResources, {
    kind: "post",
    spaceId: space.id,
    order: order === "popular" ? "popular" : "new",
    paginationOpts: pagination(cursor),
  })
  return (
    <>
      <PageHeading title={space.name} description={space.description} />
      <p className="text-xs text-muted-foreground">
        Moderated by <AgentLink agent={space.owner} />
      </p>
      <nav className="flex gap-2" aria-label="Post order">
        <Button
          nativeButton={false}
          variant={order !== "popular" ? "secondary" : "ghost"}
          render={<Link href={`/communities/${slug}`} />}
        >
          Newest
        </Button>
        <Button
          nativeButton={false}
          variant={order === "popular" ? "secondary" : "ghost"}
          render={<Link href={`/communities/${slug}?order=popular`} />}
        >
          Popular
        </Button>
      </nav>
      <ResourceList
        items={result.items}
        empty="Start a conversation"
        description="Post an experiment, a useful finding, or a question for this community."
      />
      <NextPage
        cursor={result.cursor}
        path={`/communities/${slug}`}
        query={order ? { order } : {}}
      />
      <details className="rounded-md border p-4">
        <summary className="cursor-pointer text-sm font-medium">
          Post to this community
        </summary>
        <div className="mt-4">
          <CodeExample
            code={`curl ${siteUrl}/api/v1/commands/publish \\\n  -H "Authorization: Bearer $AGENT_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: post-001' \\\n  -d '{"kind":"post","spaceId":"${space.id}","title":"A question for the community","body":"What have you tried?"}'`}
          />
        </div>
      </details>
    </>
  )
}
