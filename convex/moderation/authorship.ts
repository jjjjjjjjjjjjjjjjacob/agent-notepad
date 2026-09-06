import type { Doc, Id, TableNames } from "../_generated/dataModel"
import type { QueryCtx } from "../_generated/server"
import { agentRestricted, approvedOwner } from "./access"

export const MAX_AUTHORS = 64
export const MAX_OWNER_AGENTS = 64
export const MAX_CANDIDATES = 128
export const MAX_SEATS = 64
export const MAX_EXCLUSIONS = 256
export const MAX_ANCESTORS = 8
const MIB = 1024 * 1024
export class ModerationCapacityExceeded extends Error {}
const transactionReads = new WeakMap<QueryCtx, ModerationReads>()
export function moderationReads(ctx: QueryCtx) {
  let reads = transactionReads.get(ctx)
  if (!reads) { reads = new ModerationReads(ctx); transactionReads.set(ctx, reads) }
  return reads
}

// One budget belongs to the whole roster/seating/closure operation. Reserving
// a maximum-sized document before each read prevents a candidate multiplier
// from exceeding the transaction budget. Query iterators are consumed in full
// only when their explicit row bound and this shared byte budget both permit it.
export class ModerationReads {
  private bytes = 0
  private reads = 0
  private cache = new Map<string, unknown>()
  constructor(readonly ctx: QueryCtx, private limit = 8 * MIB) {}
  get consumedBytes() { return this.bytes }
  async read<T>(load: () => Promise<T>): Promise<T> {
    if (this.reads >= 2000 || this.bytes + MIB + 4096 > this.limit)
      throw new ModerationCapacityExceeded("Moderation read capacity exceeded.")
    this.reads++
    const value = await load()
    this.bytes += new TextEncoder().encode(JSON.stringify(value ?? null)).byteLength
    return value
  }
  async get<T extends TableNames>(id: Id<T>): Promise<Doc<T> | null> {
    if (!this.cache.has(id)) this.cache.set(id, await this.read(() => this.ctx.db.get(id)))
    return this.cache.get(id) as Doc<T> | null
  }
  async rows<T>(query: AsyncIterable<T>, maximum: number): Promise<T[]> {
    const rows: T[] = [], iterator = query[Symbol.asyncIterator]()
    try {
      for (;;) {
        const next = await this.read(() => iterator.next())
        if (next.done) return rows
        if (rows.length >= maximum)
          throw new ModerationCapacityExceeded("Moderation row capacity exceeded.")
        rows.push(next.value)
      }
    } finally {
      await iterator.return?.()
    }
  }
}

export async function snapshotAuthors(ctx: QueryCtx, resourceId: Id<"resources">) {
  const reads = moderationReads(ctx), startBytes = reads.consumedBytes
  const agents: Id<"agents">[] = [], owners: string[] = []
  let last: Id<"agents"> | undefined
  try {
    for (;;) {
      if (reads.consumedBytes - startBytes + MIB + 4096 > 4 * MIB) throw new ModerationCapacityExceeded()
      const author = last
      const revision = await reads.read(() => ctx.db.query("revisions").withIndex("by_resource_author", q =>
        author ? q.eq("resourceId", resourceId).gt("authorId", author) : q.eq("resourceId", resourceId)
      ).first())
      if (!revision) return { agents, owners, complete: true }
      if (agents.length >= MAX_AUTHORS) throw new ModerationCapacityExceeded()
      agents.push(revision.authorId)
      const agent = await reads.get(revision.authorId)
      // Deleted attribution is uncertain, not evidence of independence.
      if (!agent) throw new ModerationCapacityExceeded()
      if (agent.ownerId) owners.push(agent.ownerId)
      last = revision.authorId
    }
  } catch (error) {
    if (!(error instanceof ModerationCapacityExceeded)) throw error
    return { agents, owners, complete: false }
  }
}

export async function caseLineage(reads: ModerationReads, c: Doc<"moderationCases">) {
  const cases: Doc<"moderationCases">[] = [], seen = new Set<string>()
  for (;;) {
    if (seen.has(c._id) || cases.length >= MAX_ANCESTORS || c.authorshipState === "incomplete" ||
      c.excludedAgents.length > MAX_EXCLUSIONS || c.excludedOwners.length > MAX_EXCLUSIONS)
      throw new ModerationCapacityExceeded("Case authorship cannot be established within its bound.")
    seen.add(c._id)
    cases.push(c)
    if (!c.parentCaseId) return cases
    const parent = await reads.get(c.parentCaseId)
    if (!parent) throw new ModerationCapacityExceeded("Missing case ancestry.")
    c = parent
  }
}

// Frozen exclusions remain permanent. Live ownership and historical authorship
// are additional checks, shared by jurors, evidence access and administrators.
export async function caseConflict(reads: ModerationReads, c: Doc<"moderationCases">, ownerId: string, agentId?: Id<"agents">) {
  const lineage = await caseLineage(reads, c), resources = new Set<Id<"resources">>()
  for (const item of lineage) {
    if (item.excludedOwners.includes(ownerId) || item.subjectOwnerId === ownerId || item.reporterOwnerId === ownerId ||
      (agentId && item.excludedAgents.includes(agentId))) return true
    for (const id of new Set([item.subjectId, ...(item.reporterId ? [item.reporterId] : []), ...item.excludedAgents])) {
      const party = await reads.get(id)
      if (!party) throw new ModerationCapacityExceeded("Missing contributor attribution.")
      if (id === agentId || party.ownerId === ownerId) return true
    }
    if (item.resourceId) resources.add(item.resourceId)
    // Earlier decision-makers are excluded from appeal/reopened panels.
    if (item._id !== c._id && item.decidedBy === ownerId) return true
  }
  if (!resources.size) return false
  const siblings = await reads.rows(reads.ctx.db.query("agents").withIndex("by_owner", q => q.eq("ownerId", ownerId)), MAX_OWNER_AGENTS)
  for (const resourceId of resources) for (const sibling of siblings) {
    if (await reads.read(() => reads.ctx.db.query("revisions").withIndex("by_resource_author", q =>
      q.eq("resourceId", resourceId).eq("authorId", sibling._id)
    ).first())) return true
  }
  return false
}

export async function jurorEligible(reads: ModerationReads, c: Doc<"moderationCases">, agentId: Id<"agents">, ownerId: string) {
  const agent = await reads.get(agentId)
  return !!agent && agent.ownerId === ownerId && await approvedOwner(reads.ctx, ownerId) &&
    !(await agentRestricted(reads.ctx, agent)) && !(await caseConflict(reads, c, ownerId, agentId))
}

// This private calculation preserves the existing eligibility/weight thresholds.
// Saturation never turns a partially read award history into a qualifying score.
export async function juryScore(reads: ModerationReads, agentId: Id<"agents">) {
  const agent = await reads.get(agentId)
  if (!agent || await agentRestricted(reads.ctx, agent)) return 0
  const rows = await reads.rows(reads.ctx.db.query("reputationEvents").withIndex("by_agent", q => q.eq("agentId", agentId)), 256)
  let score = 0
  for (const row of rows) {
    if (row.reversedAt || row.expiresAt <= Date.now() || row.maturesAt > Date.now()) continue
    const item = row.resourceId ? await reads.get(row.resourceId) : null
    const revision = row.revisionId ? await reads.get(row.revisionId) : null
    if ((row.resourceId && (!item || item.suppressed || item.quarantined)) ||
      (row.revisionId && (!revision || revision.suppressed || revision.quarantined))) continue
    score += row.points
  }
  return Math.min(100, score)
}
