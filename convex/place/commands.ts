import { requirePlaceEnabled } from "./access"
import type { MutationCtx } from "../_generated/server"
import type { Doc } from "../_generated/dataModel"
import {
  placeCommandSchemas,
  type PlaceOperation,
} from "../../lib/place-contracts"
import * as deals from "./deals"
import { asId, fail } from "../lib/core"
import { allocation, eligible, journal, reallocate, sandboxOnly } from "./money"
import { ownershipReader, pixelRecord } from "./ownership"
import { tileAddress } from "../../lib/place"
import { flagInjection } from "../integrity/operations"

export async function executePlace(
  ctx: MutationCtx,
  agent: Doc<"agents">,
  operation: PlaceOperation,
  input: unknown,
  receiptKey: string
): Promise<unknown> {
  if (operation.startsWith("place_")) {
    requirePlaceEnabled()
    sandboxOnly()
  }
  switch (operation) {
    case "place_create":
      return deals.create(
        ctx,
        agent,
        placeCommandSchemas.place_create.parse(input)
      )
    case "place_append":
      return deals.append(
        ctx,
        agent,
        placeCommandSchemas.place_append.parse(input)
      )
    case "place_seal":
      return deals.seal(ctx, agent, placeCommandSchemas.place_seal.parse(input))
    case "place_terms":
      return deals.changeTerms(
        ctx,
        agent,
        placeCommandSchemas.place_terms.parse(input)
      )
    case "place_approve":
      return deals.approve(
        ctx,
        agent,
        placeCommandSchemas.place_approve.parse(input)
      )
    case "place_buy":
      return deals.buy(ctx, agent, placeCommandSchemas.place_buy.parse(input))
    case "place_bid":
      return deals.bid(ctx, agent, placeCommandSchemas.place_bid.parse(input))
    case "place_cancel":
      return deals.cancel(
        ctx,
        agent,
        placeCommandSchemas.place_cancel.parse(input)
      )
    case "place_paint": {
      // A funding freeze restricts money, while already-owned pixels retain
      // their painting permission. Conduct restrictions are enforced separately.
      if (!agent.ownerId || agent.blocked || agent.maliciousBanId)
        fail("FORBIDDEN", "An eligible owner is required to paint.")
      const { pixels } = placeCommandSchemas.place_paint.parse(input)
      if (new Set(pixels.map((p) => p.pixel)).size !== pixels.length)
        fail("VALIDATION", "A repaint batch cannot repeat pixels.")
      const reader = ownershipReader(ctx)
      const tiles = new Map<
        number,
        { colors: Uint8Array; doc: Doc<"placeTiles"> | null }
      >()
      const changes: { pixel: number; before: number; color: number }[] = []
      for (const paint of pixels) {
        const owner = await reader.owner(await pixelRecord(ctx, paint.pixel))
        if (owner.agentId !== agent._id)
          fail("FORBIDDEN", `You do not own pixel ${paint.pixel}.`)
        const { tile, offset } = tileAddress(paint.pixel)
        if (!tiles.has(tile)) {
          const doc = await ctx.db
            .query("placeTiles")
            .withIndex("by_tile", (q) => q.eq("tile", tile))
            .unique()
          tiles.set(tile, {
            doc,
            colors: doc
              ? new Uint8Array(doc.colors.slice(0))
              : new Uint8Array(2500),
          })
        }
        const colors = tiles.get(tile)!.colors
        if (colors[offset] !== paint.color)
          changes.push({
            pixel: paint.pixel,
            before: colors[offset],
            color: paint.color,
          })
        colors[offset] = paint.color
      }
      for (const [tile, { doc, colors }] of tiles) {
        const value = {
          tile,
          colors: colors.buffer as ArrayBuffer,
          updatedAt: Date.now(),
        }
        if (doc) await ctx.db.patch(doc._id, value)
        else await ctx.db.insert("placeTiles", value)
      }
      if (changes.length)
        await ctx.db.insert("placePaints", {
          agentId: agent._id,
          pixels: changes,
        })
      return { painted: changes.length }
    }
    case "place_allocate": {
      const inputValue = placeCommandSchemas.place_allocate.parse(input)
      const manager = await eligible(ctx, agent._id)
      if (!(await allocation(ctx, agent._id))?.budgetManager)
        fail(
          "FORBIDDEN",
          "A human must explicitly grant budget-manager permission."
        )
      const postings = await reallocate(
        ctx,
        manager.ownerId,
        asId(ctx, "agents", inputValue.agentId),
        inputValue.amountCents,
        inputValue.fromAgentId
          ? asId(ctx, "agents", inputValue.fromAgentId)
          : undefined
      )
      await journal(
        ctx,
        `agent-allocation:${agent._id}:${receiptKey}`,
        "allocate",
        postings,
        [manager.ownerId]
      )
      return { allocated: inputValue.amountCents }
    }
    case "place_watch": {
      const { dealId, enabled } = placeCommandSchemas.place_watch.parse(input)
      if (!(await ctx.db.get(asId(ctx, "placeDeals", dealId))))
        fail("NOT_FOUND", "Deal not found.")
      const current = await ctx.db
        .query("watches")
        .withIndex("by_agent_target", (q) =>
          q.eq("agentId", agent._id).eq("targetId", dealId)
        )
        .unique()
      if (enabled && !current)
        await ctx.db.insert("watches", { agentId: agent._id, targetId: dealId })
      if (!enabled && current) await ctx.db.delete(current._id)
      return { watching: enabled }
    }
    case "integrity_flag": {
      if (!["operator", "moderator"].includes(agent.role))
        fail(
          "FORBIDDEN",
          "Only a trusted moderator can confirm a prompt-injection flag."
        )
      return flagInjection(
        ctx,
        placeCommandSchemas.integrity_flag.parse(input),
        { agentId: agent._id }
      )
    }
  }
}
