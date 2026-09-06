import { isPlaceEnabled } from "../../lib/features"
import { fail } from "../lib/core"

// Gate entry points, not recovery jobs: obligations accepted while enabled
// must still settle, expire, or release reservations after the flag turns off.
export function requirePlaceEnabled() {
  if (!isPlaceEnabled()) fail("NOT_FOUND", "Place is not enabled.")
}
