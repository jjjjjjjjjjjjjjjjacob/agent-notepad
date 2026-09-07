"use client"
import { track } from "./browser"
import { resourceKind, safeUrl } from "./catalog"
import { beginSearch, resultClicked } from "./journey"
import { privateSelector } from "./privacy"

export function captureClick(event: MouseEvent) {
  const target =
    event.target instanceof Element
      ? event.target.closest("a,button,[role=tab],[data-analytics-action]")
      : null
  if (!target || target.closest(privateSelector)) return
  const explicit = target.getAttribute("data-analytics-action")
  if (explicit) track("control_clicked", { action: explicit })
  else if (target.getAttribute("role") === "tab")
    track("control_clicked", { action: "tab" })
  if (!(target instanceof HTMLAnchorElement)) return
  const url = new URL(target.href, location.href)
  const rank = target.getAttribute("data-analytics-rank")
  if (rank)
    resultClicked(
      Number(rank),
      target.getAttribute("data-analytics-resource-id") ?? undefined,
      target.getAttribute("data-analytics-kind") ?? undefined,
      target.getAttribute("data-analytics-search-surface") ?? "page"
    )
  const action =
    url.origin !== location.origin
      ? "outbound"
      : target.hasAttribute("download") ||
          url.pathname.startsWith("/content/") ||
          /\.(md|json|txt)$/.test(url.pathname)
        ? "download"
        : target.closest(".citation-ref, .article-sources")
          ? "citation"
          : url.searchParams.has("revision")
            ? "revision"
            : url.hash
              ? "section"
              : url.searchParams.has("cursor")
                ? "pagination"
                : url.searchParams.has("sort")
                  ? "sort"
                  : url.searchParams.has("view")
                    ? "tab"
                    : url.searchParams.has("kind") ||
                        url.searchParams.has("topic")
                      ? "filter"
                      : url.pathname === "/connect"
                        ? "connect"
                        : "navigate"
  const locationName = target.closest("header")
    ? "header"
    : target.closest('[data-slot="sidebar"]')
      ? "sidebar"
      : "content"
  track(
    "navigation_clicked",
    {
      destination: safeUrl(target.href, location.href),
      action,
      location: locationName,
    },
    true
  )
  if (url.origin === location.origin && url.pathname === "/search") {
    const q = url.searchParams.get("q") ?? ""
    const kind = resourceKind.safeParse(url.searchParams.get("kind"))
    if (q.trim())
      beginSearch({
        surface: "page",
        query_length: Math.min(q.length, 300),
        has_topic: url.searchParams.has("topic"),
        ...(kind.success ? { kind: kind.data } : {}),
      })
  }
}
export function captureSubmit(event: SubmitEvent) {
  const form = event.target
  if (!(form instanceof HTMLFormElement) || form.closest(privateSelector))
    return
  const url = new URL(form.action, location.href)
  const channelSurface = form.dataset.analyticsSearchSurface
  const channels =
    channelSurface === "channels" || channelSurface === "channel_navigation"
  if (
    url.origin !== location.origin ||
    (!channels && url.pathname !== "/search")
  )
    return
  const data = new FormData(form)
  const q = String(
    data.get(channelSurface === "channel_navigation" ? "navq" : "q") ?? ""
  )
  const kind = resourceKind.safeParse(data.get("kind"))
  if (q.trim())
    beginSearch({
      query_length: Math.min(q.length, 300),
      has_topic: !!data.get("topic"),
      ...(kind.success ? { kind: kind.data } : {}),
      ...(channels
        ? {
            has_community:
              !!data.get("community") ||
              url.pathname.startsWith("/communities/"),
            include_empty: data.get("empty") === "true",
          }
        : {}),
      surface: channels
        ? channelSurface
        : form.closest("header")
          ? "header"
          : location.pathname === "/"
            ? "home"
            : "page",
    })
}
export function captureChange(event: Event) {
  const target = event.target
  if (
    !(
      target instanceof HTMLSelectElement || target instanceof HTMLInputElement
    ) ||
    target.closest(privateSelector)
  )
    return
  // Text fields are deliberately excluded. Local search has an explicit debounce.
  if (target instanceof HTMLInputElement && target.type !== "checkbox") return
  if (!target.closest('[data-slot="filter-toolbar"]')) return
  track("filter_changed", {
    surface: "toolbar",
    filter: target instanceof HTMLSelectElement ? "selection" : "toggle",
    ...(target instanceof HTMLInputElement ? { enabled: target.checked } : {}),
  })
}
