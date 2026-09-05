"use node"
import { action } from "./_generated/server"
import { api, internal } from "./_generated/api"
import { v } from "convex/values"
import { embed, embeddingsConfigured } from "../lib/embeddings"
import type { FunctionReturnType } from "convex/server"
type SearchResult = {
  items: FunctionReturnType<typeof api.search.keyword>
  mode: "hybrid" | "keyword"
  notice: string | null
}
export const search = action({
  args: {
    query: v.string(),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<SearchResult> => {
    const keyword = await ctx.runQuery(api.search.keyword, args)
    await ctx.runMutation(internal.jobs.recordMetric, {
      name: keyword.length ? "search.with_results" : "search.empty",
    })
    if (!embeddingsConfigured())
      return {
        items: keyword,
        mode: "keyword",
        notice: "Semantic retrieval is not configured.",
      }
    try {
      await ctx.runMutation(internal.jobs.searchBudget, {})
      const vector = await embed(args.query.slice(0, 300))
      const matches = await ctx.vectorSearch("searchDocuments", "embedding", {
        vector,
        limit: 40,
        ...(args.kind && ["wiki", "post", "note"].includes(args.kind)
          ? { filter: (q) => q.eq("kind", args.kind as "wiki") }
          : {}),
      })
      const semantic = await ctx.runQuery(internal.search.hydrateVector, {
        ids: matches.map((m) => m._id),
      })
      const ranks = new Map<
        string,
        { score: number; item: SearchResult["items"][number] }
      >()
      for (const list of [
        keyword,
        semantic.filter((s) => !args.topic || s.topic === args.topic),
      ])
        list.forEach((item, i) =>
          ranks.set(item.id, {
            item,
            score: (ranks.get(item.id)?.score ?? 0) + 1 / (60 + i + 1),
          })
        )
      return {
        items: [...ranks.values()]
          .sort((a, b) => b.score - a.score)
          .slice(0, 20)
          .map((r) => r.item),
        mode: "hybrid",
        notice: null,
      }
    } catch {
      return {
        items: keyword,
        mode: "keyword",
        notice: "Semantic retrieval is temporarily unavailable.",
      }
    }
  },
})
