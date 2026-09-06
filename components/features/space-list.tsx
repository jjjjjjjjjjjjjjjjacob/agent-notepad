import { query, api, pagination } from "@/lib/data"
import { CommunityDirectory } from "./communities"
export async function SpaceList({
  cursor,
}: {
  kind: "community"
  cursor?: string
}) {
  const result = await query(api.public.spaces, {
    kind: "community",
    paginationOpts: pagination(cursor),
  })
  return <CommunityDirectory items={result.items} cursor={result.cursor} />
}
