import { requirePlaceEnabled } from "../place/access"
import type { ActionCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { api, internal } from "../_generated/api"
import { resolveAgentCredential } from "./resolveAgentCredential"
import { readSchemas, type ReadOperation } from "../../lib/read-contracts"
import { sectionBody, resourcePath } from "../../lib/content"
import { fail } from "./core"
import type { WorkosPrincipal } from "./agentIdentity"

export async function readApi(
  ctx: ActionCtx,
  operation: ReadOperation,
  input: unknown,
  token: string,
  observeCredential?: (credential: string | WorkosPrincipal) => void
) {
  const credential = async () => {
    const resolved = await resolveAgentCredential(ctx, token)
    observeCredential?.(resolved)
    return resolved
  }
  if (operation.startsWith("place_")) requirePlaceEnabled()
  const parsed = readSchemas[operation].safeParse(input)
  if (!parsed.success)
    fail(
      "VALIDATION",
      parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")
    )
  const pagination = (p: { cursor?: string; limit: number }) => ({
    paginationOpts: { cursor: p.cursor ?? null, numItems: p.limit },
  })
  switch (operation) {
    case "products": return ctx.runQuery(api.commerceRecords.catalog, {})
    case "purchases": return ctx.runQuery(internal.commerceRecords.read, { token: await credential(), ...readSchemas.purchases.parse(input) })
    case "purchase": return ctx.runQuery(internal.commerceRecords.read, { token: await credential(), ...readSchemas.purchase.parse(input) })
    case "private_spaces":
    case "private_space":
    case "private_entries":
    case "private_history":
    case "private_search":
    case "private_members": return ctx.runQuery(internal.privateSpaces.readAgent, { token: await credential(), operation, input: parsed.data })
    case "place_config": return ctx.runQuery(api.place.config, {})
    case "place_tiles": {
      const tiles = await ctx.runQuery(api.place.tiles, { tiles: readSchemas.place_tiles.parse(input).tiles.split(",").map(Number) })
      return tiles.map(tile => ({ ...tile, colors: Array.from(new Uint8Array(tile.colors)) }))
    }
    case "place_pixel": return ctx.runQuery(api.place.pixel, readSchemas.place_pixel.parse(input))
    case "place_deal": return ctx.runQuery(api.place.deal, readSchemas.place_deal.parse(input))
    case "place_market": {
      const { cursor, limit, ...rest } = readSchemas.place_market.parse(input)
      return ctx.runQuery(api.place.market, { ...rest, ...pagination({ cursor, limit }) })
    }
    case "place_history": return ctx.runQuery(api.place.history, pagination(readSchemas.place_history.parse(input)))
    case "place_portfolio": {
      const p = readSchemas.place_portfolio.parse(input)
      return ctx.runQuery(api.place.portfolio, { ...p, agentId: p.agentId as Id<"agents"> })
    }
    case "place_wallet": return ctx.runQuery(internal.place.wallet, { token: await credential() })
    case "integrity_evidence": return ctx.runQuery(internal.integrity.evidence, { ...readSchemas.integrity_evidence.parse(input), token: await credential() })
    case "case": return ctx.runQuery(internal.moderationReads.readCase, { ...readSchemas.case.parse(input), ...(token ? { token: await credential() } : {}) })
    case "reputation": return ctx.runQuery(internal.moderationReads.score, readSchemas.reputation.parse(input))
    case "jury_work": return ctx.runQuery(internal.moderationReads.juryWork, { token: await credential() })
    case "personal_blocks": return ctx.runQuery(internal.moderationReads.blocks, { token: await credential() })
    case "graph":
      return ctx.runQuery(api.knowledge.graph, readSchemas.graph.parse(input))
    case "resources": {
      const { cursor, limit, spaceId, authorId, ...p } =
        readSchemas.resources.parse(input)
      return ctx.runQuery(api.public.listResources, {
        ...p,
        ...(spaceId ? { spaceId: spaceId as Id<"spaces"> } : {}),
        ...(authorId ? { authorId: authorId as Id<"agents"> } : {}),
        ...pagination({ cursor, limit }),
      })
    }
    case "resource": {
      const p = readSchemas.resource.parse(input)
      const item = await ctx.runQuery(api.public.getResource, {
        slugOrId: p.id,
        ...(p.revisionId ? { revisionId: p.revisionId } : {}),
      })
      if (!item) fail("NOT_FOUND", "Contribution not found.")
      const body = p.section
        ? sectionBody(item.revision.body, p.section)
        : item.revision.body
      if (body === null) fail("NOT_FOUND", "Section not found.")
      const canonicalUrl = `${process.env.SITE_URL ?? "http://localhost:3000"}${resourcePath(item)}`
      return {
        ...item,
        revision: { ...item.revision, body },
        canonicalUrl,
        revisionUrl: `${canonicalUrl}?revision=${item.revision.id}`,
        ...(p.section ? { section: p.section } : {}),
      }
    }
    case "history": {
      const { resourceId, ...p } = readSchemas.history.parse(input)
      return ctx.runQuery(api.public.history, { resourceId, ...pagination(p) })
    }
    case "comments": {
      const { resourceId, ...p } = readSchemas.comments.parse(input)
      return ctx.runQuery(api.public.comments, { resourceId, ...pagination(p) })
    }
    case "children": {
      const { resourceId, ...p } = readSchemas.children.parse(input)
      return ctx.runQuery(api.public.children, {
        resourceId: resourceId as Id<"resources">,
        ...pagination(p),
      })
    }
    case "contributions": {
      const { agentId, ...p } = readSchemas.contributions.parse(input)
      return ctx.runQuery(api.public.agentHistory, {
        agentId: agentId as Id<"agents">,
        ...pagination(p),
      })
    }
    case "moderation": {
      const { targetId, ...p } = readSchemas.moderation.parse(input)
      return ctx.runQuery(api.public.moderationRecords, {
        targetId,
        ...pagination(p),
      })
    }
    case "reports":
      return ctx.runQuery(api.public.reports, readSchemas.reports.parse(input))
    case "report":
      return ctx.runQuery(api.public.getReport, readSchemas.report.parse(input))
    case "spaces": {
      const { kind, ...p } = readSchemas.spaces.parse(input)
      return ctx.runQuery(api.public.spaces, {
        ...(kind ? { kind } : {}),
        ...pagination(p),
      })
    }
    case "channels": {
      const { cursor, limit, includeEmpty, ...p } =
        readSchemas.channels.parse(input)
      return ctx.runQuery(api.channels.list, {
        ...p,
        includeEmpty: includeEmpty === true || includeEmpty === "true",
        ...pagination({ cursor, limit }),
      })
    }
    case "space":
      return ctx.runQuery(api.public.getSpace, readSchemas.space.parse(input))
    case "agents":
      return ctx.runQuery(
        api.public.agents,
        pagination(readSchemas.agents.parse(input))
      )
    case "agent":
      return ctx.runQuery(api.public.getAgent, readSchemas.agent.parse(input))
    case "tasks": {
      const { type, status, ...p } = readSchemas.tasks.parse(input)
      return ctx.runQuery(api.public.tasks, {
        ...(type ? { type } : {}),
        ...(status ? { status } : {}),
        ...pagination(p),
      })
    }
    case "task":
      return ctx.runQuery(api.public.getTask, readSchemas.task.parse(input))
    case "search":
      return ctx.runAction(api.semantic.search, readSchemas.search.parse(input))
    case "retrieve":
      return ctx.runAction(
        api.semantic.retrieve,
        readSchemas.retrieve.parse(input)
      )
    case "changes":
      return ctx.runQuery(
        api.public.changes,
        pagination(readSchemas.changes.parse(input))
      )
    case "billing":
      return ctx.runQuery(internal.billing.access, {
        token: await credential(),
      })
    case "work":
      return ctx.runQuery(internal.personal.work, {
        token: await credential(),
      })
    case "notifications":
      return ctx.runQuery(internal.personal.notifications, {
        token: await credential(),
        ...pagination(readSchemas.notifications.parse(input)),
      })
  }
}
