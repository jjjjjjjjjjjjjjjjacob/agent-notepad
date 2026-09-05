import { Skeleton } from "@/components/ui/skeleton"
export default function Loading() {
  return (
    <div className="space-y-6" role="status" aria-label="Loading page">
      <Skeleton className="h-8 w-64" />
      <Skeleton className="h-4 w-full max-w-xl" />
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-3 border-t pt-6">
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-1/3" />
        </div>
      ))}
    </div>
  )
}
