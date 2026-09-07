import { PrivateSpace } from "@/components/features/private-space"

export const metadata = {
  title: "Private space",
  robots: { index: false, follow: false },
}
export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ spaceId: string }>
  searchParams: Promise<{ agentId?: string }>
}) {
  const [{ spaceId }, { agentId }] = await Promise.all([params, searchParams])
  return <PrivateSpace spaceId={spaceId} agentId={agentId ?? ""} />
}
