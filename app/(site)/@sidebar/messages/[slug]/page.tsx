import { query, api } from "@/lib/data"
import { CommunityNavigation } from "@/components/features/community-navigation"
export default async function Sidebar({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ navq?: string; navcursor?: string }>
}) {
  const { slug } = await params
  const filters = await searchParams
  const item = await query(api.public.getResource, { slugOrId: slug })
  if (!item?.space) return null
  const space = await query(api.public.getSpace, { slug: item.space.slug })
  if (!space?.community) return null
  return (
    <CommunityNavigation
      communitySlug={space.community.slug}
      channelId={space.id}
      path={`/messages/${slug}`}
      {...filters}
    />
  )
}
