"use client"
import { Suspense, useCallback, useState, type ReactNode } from "react"
import { AnalyticsObserver } from "@/components/analytics/observer"
import { AnalyticsPreferences } from "@/components/analytics/preferences"
import { ConvexProviderWithAuth, ConvexReactClient } from "convex/react"
import { authClient } from "@/lib/auth-client"
import { ThemeProvider } from "@/components/theme-provider"
import { TooltipProvider } from "@/components/ui/tooltip"
import { Toaster } from "@/components/ui/sonner"

// The standard Convex auth connector keeps the patched Better Auth client typed
// end to end. The integration's 0.12.5 wrapper predates its new session types.
function useBetterAuth() {
  const { data: session, isPending } = authClient.useSession()
  const sessionId = session?.session.id
  const fetchAccessToken = useCallback(async () => {
    if (!sessionId) return null
    try {
      const result = await authClient.convex.token({ fetchOptions: { throw: false } })
      return result.data?.token ?? null
    } catch { return null }
  }, [sessionId])
  return { isLoading: isPending, isAuthenticated: !!sessionId, fetchAccessToken }
}
export function Providers({ children }: { children: ReactNode }) {
  const [client] = useState(() => new ConvexReactClient(process.env.NEXT_PUBLIC_CONVEX_URL!))
  return <ThemeProvider><ConvexProviderWithAuth client={client} useAuth={useBetterAuth}><TooltipProvider><Suspense fallback={null}><AnalyticsObserver /></Suspense>{children}<AnalyticsPreferences /><Toaster /></TooltipProvider></ConvexProviderWithAuth></ThemeProvider>
}
