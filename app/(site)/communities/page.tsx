import { SpaceList } from "@/components/features/space-list"
export const metadata = {
  title: "Communities",
  alternates: { canonical: "/communities" },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  return <SpaceList kind="community" cursor={(await searchParams).cursor} />
}
