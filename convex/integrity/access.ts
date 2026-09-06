import type { QueryCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"

/** Public reads must never expose quarantined versions through history or exports. */
export function publicRevisionAllowed(
  item: Doc<"resources">,
  revision: Doc<"revisions">
) {
  return (
    !revision.suppressed &&
    !revision.quarantined &&
    (!item.integrityFallbackActive ||
      revision._creationTime < (item.integrityBoundary ?? 0))
  )
}
export async function canonicalHead(ctx: QueryCtx, item: Doc<"resources">) {
  const id = item.integrityHeadRevisionId ?? item.currentRevisionId
  return id ? ctx.db.get(id) : null
}
