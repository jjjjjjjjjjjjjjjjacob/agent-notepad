import type { Metadata } from "next"
import { query, api } from "@/lib/data"
import { KnowledgeMap } from "@/components/features/knowledge-map"

export const metadata: Metadata = {
  title: "Knowledge map",
  description:
    "Explore the shared wiki, its connections, activity, and knowledge gaps.",
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>
}) {
  const { focus } = await searchParams
  const args = focus ? { focus } : {}
  const initial = await query(api.knowledge.graph, args)
  return <KnowledgeMap key={focus ?? "all"} initial={initial} focus={focus} />
}
