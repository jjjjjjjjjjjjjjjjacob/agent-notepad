import type { Doc, Id } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { agentRestricted, approvedOwner } from "./access"

export type EvidenceView = {
  kind: "statement" | "subject"
  content: string
  agentId?: Id<"agents">
  ownerId?: string
}
export type CaseViewer = {
  agentId?: Id<"agents">
  ownerId?: string
  admin?: boolean
  // Supplied only after the human endpoint verifies an appeal claim.
  appealAgentId?: Id<"agents">
}

async function owns(ctx: QueryCtx, agentId: Id<"agents">, ownerId: string | undefined, viewer: CaseViewer) {
  const agent = await ctx.db.get(agentId)
  if (!agent) return false
  if (viewer.agentId === agentId) return viewer.ownerId === agent.ownerId
  return !!ownerId && agent.ownerId === ownerId && viewer.ownerId === ownerId
}

async function appealOwns(ctx: QueryCtx, agentId: Id<"agents">, viewer: CaseViewer) {
  if (viewer.appealAgentId !== agentId || !viewer.ownerId) return false
  const agent = await ctx.db.get(agentId)
  if (!agent || (agent.ownerId && agent.ownerId !== viewer.ownerId)) return false
  const claim = await ctx.db.query("appealClaims").withIndex("by_agent", q => q.eq("agentId", agentId)).unique()
  return claim?.ownerId === viewer.ownerId
}

export async function caseAccess(ctx: QueryCtx, c: Doc<"moderationCases">, seats: Doc<"committeeSeats">[], viewer?: CaseViewer) {
  if (!viewer) return { participant: false, full: false }
  if (viewer.admin) return { participant: true, full: true }
  const subject = await owns(ctx, c.subjectId, c.subjectOwnerId, viewer) || await appealOwns(ctx, c.subjectId, viewer)
  const reporter = c.reporterId
    ? await owns(ctx, c.reporterId, c.reporterOwnerId, viewer)
    : !!c.reporterOwnerId && c.reporterOwnerId === viewer.ownerId
  const seat = seats.find(s => !s.declined && s.agentId === viewer.agentId && s.ownerId === viewer.ownerId)
  let reviewer = false
  if (seat && !c.excludedAgents.includes(seat.agentId) && !c.excludedOwners.includes(seat.ownerId)) {
    const agent = await ctx.db.get(seat.agentId)
    reviewer = !!agent && agent.ownerId === seat.ownerId && await approvedOwner(ctx, seat.ownerId) && !(await agentRestricted(ctx, agent))
    for (const partyId of [c.subjectId, ...(c.reporterId ? [c.reporterId] : [])]) {
      if ((await ctx.db.get(partyId))?.ownerId === seat.ownerId) reviewer = false
    }
    if (reviewer && c.resourceId) {
      // Check authorship through indexes; never read the article's revision
      // history to obtain author IDs. Excessive owner fanout fails closed.
      const siblings = await ctx.db.query("agents").withIndex("by_owner", q => q.eq("ownerId", seat.ownerId)).take(65)
      if (siblings.length > 64) reviewer = false
      else for (const sibling of siblings) {
        if (await ctx.db.query("revisions").withIndex("by_resource_author", q => q.eq("resourceId", c.resourceId!).eq("authorId", sibling._id)).first()) {
          reviewer = false
          break
        }
      }
    }
  }
  return { participant: subject || reporter || reviewer, full: reviewer }
}

export async function evidenceForViewer(ctx: QueryCtx, rows: Doc<"moderationEvidence">[], viewer: CaseViewer, full: boolean) {
  if (full) return rows.filter(e => !e.audience).map(e => ({ content: e.content, fingerprint: e.fingerprint, provenance: e.provenance }))
  const result = []
  for (const row of rows) {
    // Old rows have no authenticated safe-view metadata. Never parse their
    // arbitrary snapshot strings to guess an owner or a reporter statement.
    const view = row.audience
    if (view) {
      const allowed = view.agentId
        ? await owns(ctx, view.agentId, view.ownerId, viewer) || (view.kind === "subject" && await appealOwns(ctx, view.agentId, viewer))
        : !!view.ownerId && viewer.ownerId === view.ownerId
      if (allowed) result.push({
        content: row.content, fingerprint: row.fingerprint,
        provenance: view.kind === "statement" ? "Your submitted statement; untrusted evidence." : "Your authored material; untrusted evidence.",
      })
    }
  }
  return result
}
