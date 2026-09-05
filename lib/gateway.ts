import "server-only"
export function backendSite() {
  const value = process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  if (!value)
    throw new Error(
      "NEXT_PUBLIC_CONVEX_SITE_URL is required. Run bun run backend first."
    )
  return value.replace(/\/$/, "")
}
export async function forwardApi(path: string, init: RequestInit = {}) {
  return fetch(`${backendSite()}/api/v1/${path}`, {
    ...init,
    cache: "no-store",
    signal: AbortSignal.timeout(55_000),
  })
}
