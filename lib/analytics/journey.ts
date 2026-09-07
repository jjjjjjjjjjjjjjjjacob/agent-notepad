"use client"
import {
  analyticsEnabled,
  setViewContext,
  track,
  updateReplay,
} from "./browser"
import { resourceKind, routeName, searchMetadataSchema } from "./catalog"
import { searchKey } from "./consent"
import type { EventProperties } from "./catalog"

let page:
  | {
      key: string
      id: string
      activeMs: number
      since: number | null
      ended: boolean
      milestones: Set<number>
      sections: Set<number>
    }
  | undefined
const searches = new Map<string, { viewId: string; id: string }>()
function activeMs() {
  return page
    ? Math.min(
        86_400_000,
        page.activeMs +
          (page.since === null ? 0 : performance.now() - page.since)
      )
    : 0
}
export function endPage() {
  if (!page || page.ended) return
  track("$pageleave", { active_ms: activeMs() }, true)
  page.ended = true
}
export function commitPage() {
  if (!analyticsEnabled() || document.hidden) return
  // Raw location is compared only in memory; it is never persisted or captured.
  const key = location.pathname + location.search
  if (page?.key === key && !page.ended) {
    updateReplay(location.pathname)
    return
  }
  endPage()
  searches.clear()
  page = {
    key,
    id: crypto.randomUUID(),
    activeMs: 0,
    since: document.hidden ? null : performance.now(),
    ended: false,
    milestones: new Set(),
    sections: new Set(),
  }
  setViewContext(page.id, location.pathname)
  const attribution: EventProperties<"$pageview"> = {}
  try {
    if (document.referrer)
      attribution.referrer_domain = new URL(document.referrer).hostname
  } catch {
    /* no referrer */
  }
  const params = new URLSearchParams(location.search)
  // Only deliberately configured campaign labels, never arbitrary URL values.
  const campaigns = (process.env.NEXT_PUBLIC_ANALYTICS_CAMPAIGNS ?? "")
    .split(",")
    .filter(Boolean)
  for (const [param, key] of [
    ["utm_source", "campaign_source"],
    ["utm_medium", "campaign_medium"],
    ["utm_campaign", "campaign_name"],
  ] as const) {
    const value = params.get(param)
    if (value && campaigns.includes(value)) attribution[key] = value
  }
  track("$pageview", attribution, true)
  const route = routeName(location.pathname)
  if (route.endsWith("/[detail]")) {
    const kind = resourceKind.safeParse(
      (
        {
          wiki: "wiki",
          notebooks: "note",
          posts: "post",
          messages: "message",
        } as Record<string, string>
      )[location.pathname.split("/")[1]]
    )
    const resource = document.querySelector<HTMLElement>(
      "[data-analytics-resource-view]"
    )?.dataset
    const mode = resource?.analyticsResourceMode
    track("resource_viewed", {
      ...(kind.success ? { kind: kind.data } : {}),
      ...(resource?.analyticsResourceId
        ? { resource_id: resource.analyticsResourceId }
        : {}),
      ...(resource?.analyticsRevisionId
        ? { revision_id: resource.analyticsRevisionId }
        : {}),
      ...(["article", "discussion", "history", "diff"].includes(mode ?? "")
        ? {
            resource_mode: mode as
              "article" | "discussion" | "history" | "diff",
          }
        : {}),
    })
  }
  updateReplay(location.pathname)
  readingProgress(document)
}
export function visibilityChanged() {
  if (!document.hidden) commitPage()
  if (!page) return
  page.activeMs = activeMs()
  page.since = document.hidden ? null : performance.now()
}
export function readingProgress(target: EventTarget | null) {
  if (
    !page ||
    page.ended ||
    document.hidden ||
    !/\/(wiki|posts|notebooks|messages)\//.test(location.pathname)
  )
    return
  const article = document.querySelector<HTMLElement>(
    "[data-analytics-reading] .markdown"
  )
  if (!article || (target instanceof Element && !target.contains(article)))
    return
  const bounds = article.getBoundingClientRect()
  if (bounds.height <= 0 || bounds.top >= innerHeight) return
  const depth = Math.min(
    100,
    Math.round((100 * Math.max(0, innerHeight - bounds.top)) / bounds.height)
  )
  const sections = article.querySelectorAll("h2,h3")
  sections.forEach((section, index) => {
    const rect = section.getBoundingClientRect()
    if (rect.top >= 0 && rect.top < innerHeight && !page!.sections.has(index)) {
      page!.sections.add(index)
      track("article_section_viewed", {
        section_index: index + 1,
        section_count: sections.length,
      })
    }
  })
  for (const milestone of [25, 50, 75, 100] as const) {
    if (depth >= milestone && !page.milestones.has(milestone)) {
      page.milestones.add(milestone)
      track("reading_progress", { milestone, active_ms: activeMs() })
    }
  }
}
export function beginSearch(
  properties: Omit<EventProperties<"search_submitted">, "search_id">
) {
  if (!analyticsEnabled()) return
  const search_id = crypto.randomUUID()
  const checked = searchMetadataSchema.safeParse({ ...properties, search_id })
  if (!checked.success) return
  try {
    sessionStorage.setItem(
      searchKey,
      JSON.stringify({ ...checked.data, created: Date.now() })
    )
  } catch {
    /* direct-result attribution remains possible */
  }
  track("search_submitted", checked.data, true)
}
export type SearchResultProperties = Omit<
  EventProperties<"search_results_viewed">,
  "search_id" | "surface"
> & {
  failed?: boolean
  surface?: EventProperties<"search_results_viewed">["surface"]
}
export function searchResults(properties: SearchResultProperties) {
  if (!analyticsEnabled()) return
  commitPage()
  const key = properties.surface ?? "page"
  if (!page || searches.get(key)?.viewId === page.id) return
  let search_id = crypto.randomUUID() as string
  let surface: EventProperties<"search_submitted">["surface"] =
    properties.surface ?? "direct"
  try {
    const pending = JSON.parse(sessionStorage.getItem(searchKey) ?? "null")
    const saved = searchMetadataSchema.safeParse(pending)
    const age = Date.now() - pending?.created
    if (!saved.success || !Number.isFinite(age) || age < 0 || age >= 60_000) {
      sessionStorage.removeItem(searchKey)
    } else if (
      (["channels", "channel_navigation"].includes(key)
        ? saved.data.surface === key
        : !["channels", "channel_navigation"].includes(saved.data.surface)) &&
      saved.data.query_length === properties.query_length
    ) {
      sessionStorage.removeItem(searchKey)
      search_id = saved.data.search_id
      surface = saved.data.surface
    }
  } catch {
    /* direct navigation */
  }
  searches.set(key, { viewId: page.id, id: search_id })
  if (properties.failed)
    track("search_failed", {
      ...properties,
      search_id,
      surface,
      error_code: "search_unavailable",
    })
  else track("search_results_viewed", { ...properties, search_id, surface })
}
export function resultClicked(
  rank: number,
  resourceId?: string,
  kind?: string,
  surface = "page"
) {
  const search_id = searchCorrelation(surface)
  if (!search_id) return
  const parsed = resourceKind.safeParse(kind)
  track("search_result_clicked", {
    search_id,
    rank,
    ...(resourceId ? { resource_id: resourceId } : {}),
    ...(parsed.success ? { kind: parsed.data } : {}),
  })
}
export function searchCorrelation(surface: string) {
  const search = searches.get(surface)
  return search?.viewId === page?.id ? search?.id : undefined
}
/** Debounced local results do not navigate; each completed filter has its own ID. */
export function localSearch(
  properties: Omit<
    EventProperties<"search_results_viewed">,
    "search_id" | "surface" | "mode"
  >
) {
  if (!analyticsEnabled()) return false
  commitPage()
  if (!page) return false
  const search_id = crypto.randomUUID()
  searches.set("map", { viewId: page.id, id: search_id })
  track("search_submitted", { ...properties, surface: "map", search_id })
  track("search_results_viewed", {
    ...properties,
    surface: "map",
    search_id,
    mode: "local",
  })
  return true
}
export function resetJourney() {
  page = undefined
  searches.clear()
}
