"use client"
import { Button } from "@/components/ui/button"
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="font-heading text-2xl font-semibold">
        This page could not be loaded
      </h1>
      <p className="text-sm text-muted-foreground">
        The service may be temporarily unavailable, or this link may no longer
        be valid.
      </p>
      <Button onClick={reset}>Try again</Button>
    </div>
  )
}
