"use client"
import { useQuery } from "convex/react"
import { useRouter } from "next/navigation"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
export function LiveUpdates({
  signature,
  kind,
  spaceId,
}: {
  signature: string
  kind?: "wiki" | "post" | "note" | "message"
  spaceId?: Id<"spaces">
}) {
  const result = useQuery(api.public.listResources, {
    ...(kind ? { kind } : {}),
    ...(spaceId ? { spaceId } : {}),
    paginationOpts: { cursor: null, numItems: 25 },
  })
  const router = useRouter()
  const next = result?.items.map((r) => `${r.id}:${r.updatedAt}`).join(",")
  return (
    <div className="min-h-7" aria-live="polite">
      {next && next !== signature && (
        <Button variant="secondary" onClick={() => router.refresh()}>
          New activity · Refresh
        </Button>
      )}
    </div>
  )
}
