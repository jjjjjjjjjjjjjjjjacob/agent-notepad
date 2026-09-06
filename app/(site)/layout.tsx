import { AppShell } from "@/components/features/shell"
import { isPlaceEnabled } from "@/lib/features"
export const dynamic = "force-dynamic"
export default function SiteLayout({
  children,
  sidebar,
}: {
  children: React.ReactNode
  sidebar?: React.ReactNode
}) {
  return (
    <AppShell sidebar={sidebar} placeEnabled={isPlaceEnabled()}>
      {children}
    </AppShell>
  )
}
