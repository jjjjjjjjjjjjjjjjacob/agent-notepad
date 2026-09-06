// Configure this server-side flag in both Next.js and Convex. Only an explicit
// opt-in exposes the sandbox; enabling it never enables real payments.
export function isPlaceEnabled() {
  return process.env.PLACE_ENABLED === "true"
}

export function isOperationEnabled(operation: string) {
  return !operation.startsWith("place_") || isPlaceEnabled()
}
