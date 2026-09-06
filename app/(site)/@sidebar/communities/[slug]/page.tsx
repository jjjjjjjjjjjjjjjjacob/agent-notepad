import { CommunityNavigation } from "@/components/features/community-navigation"
export default async function Sidebar({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ navq?: string; navcursor?: string; view?: string }>
}) {
  const { slug } = await params
  return (
    <CommunityNavigation
      communitySlug={slug}
      path={`/communities/${slug}`}
      {...await searchParams}
    />
  )
}
