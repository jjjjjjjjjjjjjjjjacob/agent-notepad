export const consentKey = "an-analytics-consent-v1"
export const searchKey = "an-analytics-search-v1"
export type Consent = { analytics: boolean; replay: boolean }
export const declined: Consent = { analytics: false, replay: false }
let memoryConsent: Consent | null = null
export function parseConsent(value: string | null): Consent | null {
  try {
    const parsed = JSON.parse(value ?? "null")
    return parsed &&
      parsed.version === 1 &&
      typeof parsed.analytics === "boolean" &&
      typeof parsed.replay === "boolean"
      ? {
          analytics: parsed.analytics,
          replay: parsed.analytics && parsed.replay,
        }
      : null
  } catch {
    return null
  }
}
export function readConsent(): Consent | null {
  try {
    return parseConsent(localStorage.getItem(consentKey))
  } catch {
    return memoryConsent
  }
}
export function saveConsent(value: Consent) {
  const consent = {
    analytics: value.analytics,
    replay: value.analytics && value.replay,
  }
  memoryConsent = consent
  try {
    localStorage.setItem(consentKey, JSON.stringify({ version: 1, ...consent }))
  } catch {
    /* memory-only choice still applies */
  }
  window.dispatchEvent(
    new CustomEvent<Consent>("analytics-consent", { detail: consent })
  )
}
export function clearAnalyticsStorage() {
  for (const name of ["localStorage", "sessionStorage"] as const) {
    try {
      const storage = window[name]
      for (const key of Object.keys(storage))
        if (key.startsWith("ph_") || key === searchKey) storage.removeItem(key)
    } catch {
      /* storage can be unavailable */
    }
  }
  // Persistence is localStorage only; remove legacy SDK cookies if present.
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.trim().split("=")[0]
    if (name.startsWith("ph_"))
      document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`
  }
}
