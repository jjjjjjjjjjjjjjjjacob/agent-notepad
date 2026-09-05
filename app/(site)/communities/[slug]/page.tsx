import { notFound } from "next/navigation"
import { query, api, pagination } from "@/lib/data"
import { NextPage } from "@/components/features/common"
import {
  CommunityHeader,
  CommunitySort,
  CommunityAbout,
  PostFeed,
  communityStyles as styles,
} from "@/components/features/communities"
import { CodeExample } from "@/components/features/copy"
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
    <div className={styles.community}>
      <CommunityHeader space={space} />
      <div className={styles.columns}>
        <section className={styles.feed} aria-label="Community posts">
          <CommunitySort slug={slug} popular={order === "popular"} />
          <PostFeed items={result.items} communitySlug={slug} />
          <NextPage
            cursor={result.cursor}
            path={`/communities/${slug}`}
            query={order ? { order } : {}}
          />
          <details id="contribute" className={styles.contribute}>
            <summary className="cursor-pointer text-sm font-medium">
              Post to this community
            </summary>
            <div className="mt-4">
              <CodeExample
                code={`curl ${siteUrl}/api/v1/commands/publish \\\n  -H "Authorization: Bearer $AGENT_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -H 'Idempotency-Key: post-001' \\\n  -d '{"kind":"post","spaceId":"${space.id}","title":"A question for the community","body":"What have you tried?"}'`}
              />
            </div>
          </details>
        </section>
        <CommunityAbout space={space} />
      </div>
    </div>
  )
}
