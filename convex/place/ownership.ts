import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Doc, Id } from "../_generated/dataModel"
import { fail } from "../lib/core"

export type Owner = {
  agentId?: Id<"agents">
  epoch: number
  version: string
  banId?: Id<"integrityBans">
  beneficiaryId?: Id<"agents">
}
export const terminal = (status: string) =>
  ["committed", "cancelled", "expired", "failed"].includes(status)
export const auction = (deal: Pick<Doc<"placeDeals">, "kind">) =>
  ["auction", "forfeiture"].includes(deal.kind)
export function ownershipReader(ctx: QueryCtx) {
  const agents = new Map<string, Promise<Doc<"agents"> | null>>()
  const deals = new Map<string, Promise<Doc<"placeDeals"> | null>>()
  const agent = (id: Id<"agents">) => {
    if (!agents.has(id)) agents.set(id, ctx.db.get(id))
    return agents.get(id)!
  }
  const deal = (id: Id<"placeDeals">) => {
    if (!deals.has(id)) deals.set(id, ctx.db.get(id))
    return deals.get(id)!
  }
  return {
    agent,
    deal,
    async owner(pixel: Doc<"placePixels"> | null): Promise<Owner> {
      if (!pixel) return { epoch: 0, version: "unowned" }
      let agentId = pixel.ownerId,
        epoch = pixel.epoch,
        version = pixel.version
      if (pixel.pendingDealId) {
        const pending = await deal(pixel.pendingDealId)
        if (pending?.status === "committed") {
          agentId = pending.buyerId
          epoch = pending.buyerEpoch ?? 0
          version = pending._id
        }
      }
      if (!agentId) return { epoch, version }
      const current = await agent(agentId)
      if (current?.maliciousBanId && epoch < (current.placeEpoch ?? 0))
        return {
          epoch,
          version: `${version}:forfeit:${current.maliciousBanId}`,
          banId: current.maliciousBanId,
          beneficiaryId: agentId,
        }
      return { agentId, epoch, version }
    },
  }
}
export async function pixelRecord(ctx: QueryCtx, pixel: number) {
  return ctx.db
    .query("placePixels")
    .withIndex("by_pixel", (q) => q.eq("pixel", pixel))
    .unique()
}
export async function getDeal(ctx: QueryCtx, id: Id<"placeDeals">) {
  const deal = await ctx.db.get(id)
  if (!deal) fail("NOT_FOUND", "Pixel deal not found.")
  return deal
}
export async function materialize(ctx: MutationCtx, pixel: Doc<"placePixels">) {
  if (!pixel.pendingDealId) return pixel
  const parent = await ctx.db.get(pixel.pendingDealId)
  if (!parent || !terminal(parent.status))
    fail("CONFLICT", "Pixels are reserved by another pending deal.")
  const patch =
    parent.status === "committed"
      ? {
          ownerId: parent.buyerId,
          epoch: parent.buyerEpoch ?? 0,
          version: parent._id as string,
          pendingDealId: undefined,
          prospectiveBuyer: undefined,
        }
      : { pendingDealId: undefined, prospectiveBuyer: undefined }
  await ctx.db.patch(pixel._id, patch)
  return { ...pixel, ...patch }
}
