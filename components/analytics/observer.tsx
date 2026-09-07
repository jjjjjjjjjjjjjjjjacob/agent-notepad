"use client"
import { useEffect } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useReportWebVitals } from "next/web-vitals"
import { authClient } from "@/lib/auth-client"
import {
  analyticsEnabled,
  identifyHuman,
  startAnalytics,
  track,
} from "@/lib/analytics/browser"
import {
  commitPage,
  endPage,
  readingProgress,
  resetJourney,
  searchResults,
  visibilityChanged,
  type SearchResultProperties,
} from "@/lib/analytics/journey"
import {
  captureChange,
  captureClick,
  captureSubmit,
} from "@/lib/analytics/interactions"

const reportVitals: Parameters<typeof useReportWebVitals>[0] = (metric) => {
  track("web_vital", {
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    metric_id: metric.id,
  })
}
export function AnalyticsObserver() {
  const pathname = usePathname()
  const params = useSearchParams().toString()
  const { data: session, isPending } = authClient.useSession()
  useReportWebVitals(reportVitals)
  useEffect(() => {
    startAnalytics()
    const consentChanged = () => {
      if (analyticsEnabled()) commitPage()
      else resetJourney()
    }
    const scroll = (event: Event) => readingProgress(event.target)
    window.addEventListener("analytics-consent", consentChanged)
    window.addEventListener("analytics-ready", commitPage)
    window.addEventListener("pageshow", commitPage)
    window.addEventListener("pagehide", endPage)
    document.addEventListener("visibilitychange", visibilityChanged)
    document.addEventListener("scroll", scroll, {
      capture: true,
      passive: true,
    })
    document.addEventListener("click", captureClick, true)
    document.addEventListener("submit", captureSubmit, true)
    document.addEventListener("change", captureChange, true)
    return () => {
      window.removeEventListener("analytics-consent", consentChanged)
      window.removeEventListener("analytics-ready", commitPage)
      window.removeEventListener("pageshow", commitPage)
      window.removeEventListener("pagehide", endPage)
      document.removeEventListener("visibilitychange", visibilityChanged)
      document.removeEventListener("scroll", scroll, true)
      document.removeEventListener("click", captureClick, true)
      document.removeEventListener("submit", captureSubmit, true)
      document.removeEventListener("change", captureChange, true)
    }
  }, [])
  useEffect(() => {
    if (!isPending) identifyHuman(session?.user.id ?? null)
  }, [isPending, session?.user.id])
  useEffect(() => {
    commitPage()
  }, [pathname, params])
  return null
}
export function SearchResultAnalytics(properties: SearchResultProperties) {
  const params = useSearchParams().toString()
  const {
    query_length,
    kind,
    has_topic,
    has_community,
    sort_order,
    activity_window,
    include_empty,
    surface,
    result_count,
    mode,
    duration_ms,
    failed,
  } = properties
  useEffect(() => {
    const report = () =>
      searchResults({
        query_length,
        kind,
        has_topic,
        has_community,
        sort_order,
        activity_window,
        include_empty,
        surface,
        result_count,
        mode,
        duration_ms,
        failed,
      })
    report()
    window.addEventListener("analytics-ready", report)
    window.addEventListener("analytics-consent", report)
    return () => {
      window.removeEventListener("analytics-ready", report)
      window.removeEventListener("analytics-consent", report)
    }
  }, [
    params,
    query_length,
    kind,
    has_topic,
    has_community,
    sort_order,
    activity_window,
    include_empty,
    surface,
    result_count,
    mode,
    duration_ms,
    failed,
  ])
  return null
}
