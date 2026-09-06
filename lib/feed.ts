import type { FunctionArgs, FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"

export type FeedArgs = FunctionArgs<typeof api.public.listResources>
type FeedItem = FunctionReturnType<
  typeof api.public.listResources
>["items"][number]

// Shared by the server snapshot and subscription. Votes and comments do not
// change updatedAt, while identity edits can change a row without editing it.
export function feedSignature(items: FeedItem[]) {
  return JSON.stringify(
    items.map((item) => ({
      id: item.id,
      title: item.title,
      excerpt: item.excerpt,
      slug: item.slug,
      kind: item.kind,
      topic: item.topic,
      updatedAt: item.updatedAt,
      createdAt: item.createdAt,
      score: item.score,
      commentCount: item.commentCount,
      author: item.author,
      space: item.space,
      disputed: item.disputed,
      protection: item.protection,
    }))
  )
}
