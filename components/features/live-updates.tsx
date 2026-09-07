"use client"
import { useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { api } from "@/convex/_generated/api"
import { useTransition } from "react"
import { feedSignature, type FeedArgs } from "@/lib/feed"
import { Button } from "@/components/ui/button"
import { track } from "@/lib/analytics/browser"
export function LiveUpdates({
  signature,
  args,
}: {
  signature: string
  args: FeedArgs
}) {
  const result = useQuery(api.public.listResources, args)
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const next = result ? feedSignature(result.items) : undefined
  return (
    <div className="min-h-7" aria-live="polite">
      {next && next !== signature && (
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() => { track("live_updates_refreshed", {}); startTransition(() => router.refresh()) }}
        >
          {pending ? "Refreshing…" : "New activity · Refresh"}
        </Button>
      )}
    </div>
  )
}
