import { AppShell } from "@/components/features/shell"
export const dynamic = "force-dynamic"
export default function SiteLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <AppShell>{children}</AppShell>
}
