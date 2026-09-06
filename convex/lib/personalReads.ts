import { publicRevisionAllowed } from "../integrity/access";
import { blockedFor } from "../moderation/access";
import { visibleContribution } from "./channels";
import type { PaginationOptions } from "convex/server";
import type { QueryCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { taskView } from "./views";

export async function personalWork(ctx: QueryCtx, agentId: Id<"agents">) {
    const active = await ctx.db
      .query("assignments")
      .withIndex("by_agent_status", (q) =>
        q.eq("agentId", agentId).eq("status", "active")
      )
      .unique()
    const waiting = await ctx.db
      .query("assignments")
      .withIndex("by_agent_status", (q) =>
        q.eq("agentId", agentId).eq("status", "waiting")
      )
      .unique()
    const assignment = active ?? waiting
    return assignment
      ? {
          ...assignment,
          task: assignment.taskId
            ? await (async () => {
                const task = await ctx.db.get(assignment.taskId!)
                return task ? taskView(ctx, task, true) : null
              })()
            : null,
        }
      : null
}

export async function personalNotifications(ctx: QueryCtx, agentId: Id<"agents">, paginationOpts: PaginationOptions) {
    const page = await ctx.db
      .query("notices")
      .withIndex("by_agent", (q) => q.eq("agentId", agentId))
      .order("desc")
      .paginate({
        ...paginationOpts,
        numItems: Math.min(paginationOpts.numItems, 50),
      })
    const items = []
    for (const notice of page.page) {
      const event = await ctx.db.get(notice.eventId)
      if (!event || (event.suppressed || event.quarantined) || await blockedFor(ctx, `agent:${agentId}`, event.actorId)) continue
      if (event.revisionId && (await ctx.db.get(event.revisionId))?.quarantined) continue
      const spaceId = ctx.db.normalizeId("spaces", event.targetId)
      if (spaceId) { const space = await ctx.db.get(spaceId); if (!space || space.quarantined || space.suppressed) continue }
      const resourceId = ctx.db.normalizeId("resources", event.targetId)
      if (resourceId) { const item = await ctx.db.get(resourceId); if (!item || !await visibleContribution(ctx, item)) continue; if (event.revisionId) { const revision = await ctx.db.get(event.revisionId); if (!revision || !publicRevisionAllowed(item, revision)) continue } else if (item.integrityFallbackActive && event._creationTime >= (item.integrityBoundary ?? 0)) continue }
      items.push({ id: notice._id, event })
    }
    return { items, cursor: page.isDone ? null : page.continueCursor }
}
