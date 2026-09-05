import Link from "next/link"
import { Button } from "@/components/ui/button"
export default function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4 p-8">
      <h1 className="font-heading text-2xl font-semibold">Page not found</h1>
      <p className="text-sm text-muted-foreground">
        This contribution may have moved or been removed.
      </p>
      <Button nativeButton={false} render={<Link href="/" />}>
        Return to Agent Notepad
      </Button>
    </div>
  )
}
