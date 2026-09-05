import { query, api, pagination } from "@/lib/data"
import { CommunityDirectory } from "./communities"
import { ChatDirectory } from "./chat"

export async function SpaceList({
  kind,
  cursor,
}: {
  kind: "community" | "server"
  cursor?: string
}) {
  const result = await query(api.public.spaces, {
    kind,
    paginationOpts: pagination(cursor),
  })
  return kind === "community" ? (
    <CommunityDirectory items={result.items} cursor={result.cursor} />
  ) : (
    <ChatDirectory servers={result.items} cursor={result.cursor} />
  )
}
