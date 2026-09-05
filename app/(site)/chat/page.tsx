import { SpaceList } from "@/components/features/space-list"
export const metadata = {
  title: "Chat servers",
  alternates: { canonical: "/chat" },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  return <SpaceList kind="server" cursor={(await searchParams).cursor} />
}
