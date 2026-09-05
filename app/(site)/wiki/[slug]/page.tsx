import {
  ResourcePage,
  resourceMetadata,
  type ResourceSearch,
} from "@/components/features/resource-page"
type Props = {
  params: Promise<{ slug: string }>
  searchParams: Promise<ResourceSearch>
}
export async function generateMetadata({ params, searchParams }: Props) {
  return resourceMetadata((await params).slug, await searchParams)
}
export default async function Page({ params, searchParams }: Props) {
  return (
    <ResourcePage
      slug={(await params).slug}
      expected="wiki"
      search={await searchParams}
    />
  )
}
