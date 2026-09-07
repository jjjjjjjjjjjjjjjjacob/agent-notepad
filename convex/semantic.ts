"use node"
import { Effect } from "effect"
import { AppError } from "../lib/errors"
import { attempt, runConvex, validate } from "../lib/effects"
import { action } from "./_generated/server"
import { api, internal } from "./_generated/api"
import { v } from "convex/values"
import {
  embedEffect,
  embedManyEffect,
  embeddingsConfigured,
} from "../lib/embeddings"
import type { FunctionReturnType } from "convex/server"
import type { RetrievalPack } from "./retrieval"
import type { ActionCtx } from "./_generated/server"
import { readSchemas } from "../lib/read-contracts"
import { fuseRanks, SEARCH_CANDIDATES } from "../lib/retrieval"

function vectorMatchesEffect(
  ctx: ActionCtx,
  args: { query: string; kind?: string; topic?: string },
  limit: number,
  suppliedVector?: number[]
) {
  return Effect.gen(function* () {
    if (!suppliedVector)
      yield* attempt(() => ctx.runMutation(internal.jobs.searchBudget, {}))
    const vector = suppliedVector ?? (yield* embedEffect(args.query))
    return yield* attempt(() =>
      ctx.vectorSearch("searchDocuments", "embedding_bge", {
        vector,
        limit,
        ...(args.kind && args.topic !== undefined
          ? { filter: (q) => q.eq("scope", `${args.kind}:${args.topic}`) }
          : args.topic !== undefined
            ? { filter: (q) => q.eq("topic", args.topic!) }
            : args.kind
              ? { filter: (q) => q.eq("kind", args.kind as "wiki") }
              : {}),
      })
    )
  })
}
const canFallback = (error: AppError) =>
  [
    "UNAVAILABLE",
    "TIMEOUT",
    "RATE_LIMITED",
    "NOT_CONFIGURED",
    "BAD_GATEWAY",
  ].includes(error.code)
const optionalSemantic = <A>(effect: Effect.Effect<A, AppError>) =>
  effect.pipe(Effect.catchIf(canFallback, () => Effect.succeed(null)))
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
    return runConvex(
      Effect.gen(function* () {
        args = yield* validate(readSchemas.search, args)
        if (args.kind === "message")
          return {
            items: [],
            mode: "keyword",
            notice:
              "Messages are not indexed. Read channel messages with get_resources.",
          }
        const keyword = yield* attempt(() =>
          ctx.runQuery(api.search.keyword, args)
        )
        yield* attempt(() =>
          ctx.runMutation(internal.jobs.recordMetric, {
            name: keyword.length ? "search.with_results" : "search.empty",
          })
        )
        if (!embeddingsConfigured())
          return {
            items: keyword,
            mode: "keyword",
            notice: "Semantic retrieval is not configured.",
          }
        return yield* Effect.gen(function* () {
          const matches = yield* vectorMatchesEffect(ctx, args, 40)
          const semantic = yield* attempt(() =>
            ctx.runQuery(internal.search.hydrateVector, {
              ids: matches.map((m) => m._id),
            })
          )
          const ranks = new Map<
            string,
            {
              score: number
              item: SearchResult["items"][number]
            }
          >()
          for (const list of [
            keyword,
            semantic.filter((s) => !args.topic || s.topic === args.topic),
          ])
            list.forEach((item, i) =>
              ranks.set(item.id, {
                item: ranks.get(item.id)?.item ?? item,
                score: (ranks.get(item.id)?.score ?? 0) + 1 / (60 + i + 1),
              })
            )
          return {
            items: [...ranks.values()]
              .sort((a, b) => b.score - a.score)
              .slice(0, 20)
              .map((r) => r.item),
            mode: "hybrid" as const,
            notice: null,
          }
        }).pipe(
          Effect.catchIf(canFallback, () =>
            Effect.succeed({
              items: keyword,
              mode: "keyword" as const,
              notice: "Semantic retrieval is temporarily unavailable.",
            })
          )
        )
      }),
      "semantic_search"
    )
  },
})

type RetrievalResult = RetrievalPack & {
  queries: string[]
  mode: "hybrid" | "keyword"
  notice: string | null
  candidateLimitReached: boolean
}
export const retrieve = action({
  args: {
    query: v.string(),
    queries: v.optional(v.array(v.string())),
    kind: v.optional(v.string()),
    topic: v.optional(v.string()),
    limit: v.optional(v.number()),
    maxChars: v.optional(v.number()),
    passagesPerResource: v.optional(v.number()),
  },
  handler: async (ctx, input): Promise<RetrievalResult> => {
    return runConvex(
      Effect.gen(function* () {
        const args = yield* validate(readSchemas.retrieve, input)
        const queries = [...new Set([args.query, ...(args.queries ?? [])])]
        const configured = embeddingsConfigured()
        const vectors = yield* Effect.cached(
          configured
            ? optionalSemantic(
                Effect.gen(function* () {
                  yield* attempt(() =>
                    ctx.runMutation(internal.jobs.searchBudget, {
                      count: queries.length,
                    })
                  )
                  return yield* embedManyEffect(queries, "query")
                })
              )
            : Effect.succeed(null)
        )
        const results = yield* Effect.forEach(
          queries,
          (query, index) =>
            Effect.gen(function* () {
              const filters = {
                query,
                ...(args.kind ? { kind: args.kind } : {}),
                ...(args.topic !== undefined ? { topic: args.topic } : {}),
              }
              const [keyword, semantic] = yield* Effect.all(
                [
                  attempt(() =>
                    ctx.runQuery(internal.search.candidates, filters)
                  ),
                  vectors.pipe(
                    Effect.flatMap((batch) =>
                      batch
                        ? optionalSemantic(
                            vectorMatchesEffect(
                              ctx,
                              filters,
                              SEARCH_CANDIDATES,
                              batch[index]
                            )
                          )
                        : Effect.succeed(null)
                    )
                  ),
                ],
                { concurrency: 2 }
              )
              return { keyword, semantic }
            }),
          { concurrency: queries.length }
        )
        const ranked = fuseRanks(
          results.flatMap(({ keyword, semantic }) => [
            keyword.map((item) => ({ id: item.id })),
            (semantic ?? []).map((item) => ({ id: item._id })),
          ])
        )
        const packed = yield* attempt(() =>
          ctx.runQuery(internal.retrieval.pack, {
            ids: ranked.slice(0, 160).map((item) => item.id),
            queries,
            ...(args.kind ? { kind: args.kind } : {}),
            ...(args.topic !== undefined ? { topic: args.topic } : {}),
            limit: args.limit,
            maxChars: args.maxChars,
            passagesPerResource: args.passagesPerResource,
          })
        )
        const semanticUsed = results.some((r) => r.semantic !== null)
        const candidateLimitReached =
          ranked.length > 160 ||
          results.some(
            (r) =>
              r.keyword.length === SEARCH_CANDIDATES ||
              r.semantic?.length === SEARCH_CANDIDATES
          )
        yield* attempt(() =>
          ctx.runMutation(internal.jobs.recordMetric, {
            name: packed.items.length
              ? "retrieve.with_results"
              : "retrieve.empty",
          })
        )
        return {
          ...packed,
          queries,
          candidateLimitReached,
          truncated: packed.truncated || candidateLimitReached,
          mode: semanticUsed ? "hybrid" : "keyword",
          notice: !configured
            ? "Semantic retrieval is not configured; using keyword search."
            : results.some((r) => r.semantic === null)
              ? "Semantic retrieval failed for one or more queries; keyword results are retained."
              : results.every((r) => !r.semantic?.length)
                ? "No semantic candidates were available; indexing may be pending."
                : null,
        }
      }),
      "semantic_retrieve"
    )
  },
})
