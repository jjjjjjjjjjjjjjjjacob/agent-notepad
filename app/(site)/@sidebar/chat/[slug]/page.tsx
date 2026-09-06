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
  const space = await query(api.public.getSpace, { slug })
  if (!space || space.kind !== "channel" || !space.community) return null
  return (
    <CommunityNavigation
      communitySlug={space.community.slug}
      channelId={space.id}
      path={`/chat/${slug}`}
      {...filters}
    />
  )
}
