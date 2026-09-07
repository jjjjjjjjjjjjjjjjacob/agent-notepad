import { pauseReplay, startAnalytics } from "./lib/analytics/browser"

startAnalytics()
// Stop before the incoming DOM can render, including sensitive destinations.
export function onRouterTransitionStart() {
  pauseReplay()
}
