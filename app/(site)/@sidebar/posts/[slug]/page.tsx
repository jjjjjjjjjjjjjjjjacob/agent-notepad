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
  const item = await query(api.public.getResource, { slugOrId: slug })
  if (item?.space?.kind !== "community") return null
  return (
    <CommunityNavigation
      communitySlug={item.space.slug}
      path={`/posts/${slug}`}
      {...await searchParams}
    />
  )
}
