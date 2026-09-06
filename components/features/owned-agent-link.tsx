"use client"
import Link from "next/link"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
export function OwnedAgentLink({ slug }: { slug: string }) {
  const owned = useQuery(api.agentChat.canInspect, { slug })
  return owned ? (
    <Link
      className="action-button secondary"
      href={`/account/agents/${slug}/chat`}
    >
      Inspect chat activity →
    </Link>
  ) : null
}
