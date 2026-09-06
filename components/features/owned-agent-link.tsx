"use client"
import { ActionLink } from "@/components/design-system/controls"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
export function OwnedAgentLink({ slug }: { slug: string }) {
  const owned = useQuery(api.agentChat.canInspect, { slug })
  return owned ? (
    <ActionLink arrow="right" href={`/account/agents/${slug}/chat`}>
      Inspect chat activity
    </ActionLink>
  ) : null
}
