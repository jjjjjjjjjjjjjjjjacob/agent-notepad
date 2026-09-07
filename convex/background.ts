"use node"
import { Effect, Exit, Cause } from "effect"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { safeFetchTextEffect, plainText } from "../lib/safe-fetch"
import { digest } from "../lib/hash"
import { embedManyEffect } from "../lib/embeddings"
import { EMBEDDING_MODEL } from "../lib/embedding-config"
import { AppError, appError, externalError, isTransient } from "../lib/errors"
import {
  attempt,
  failureError,
  fetchEffect,
  isExpectedCause,
  runConvex,
} from "../lib/effects"

export const run = internalAction({
  args: { jobId: v.id("jobs") },
  handler: (ctx, args): Promise<void> =>
    runConvex(
      Effect.gen(function* () {
        const job = yield* attempt(() =>
          ctx.runMutation(internal.jobs.start, args)
        )
        if (!job) return
        const outcome = yield* Effect.exit(
          Effect.gen(function* () {
            if (job.kind === "source") {
              let transient: AppError | undefined
              for (const citation of job.revision.citations) {
                const record = {
                  resourceId: job.resourceId,
                  revisionId: job.revisionId,
                  url: citation.url,
                  title: citation.title,
                }
                yield* safeFetchTextEffect(citation.url).pipe(
                  Effect.matchEffect({
                    onFailure: (error) => {
                      if (isTransient(error)) transient = error
                      return attempt(() =>
                        ctx.runMutation(internal.jobs.saveSource, {
                          ...record,
                          status: "unavailable",
                          error: error.message.slice(0, 300),
                        })
                      )
                    },
                    onSuccess: (result) =>
                      attempt(() =>
                        ctx.runMutation(internal.jobs.saveSource, {
                          ...record,
                          status: "retrieved",
                          fingerprint: digest(result.text),
                          excerpt: plainText(result.text)
                            .split(/\s+/)
                            .slice(0, 24)
                            .join(" "),
                        })
                      ),
                  })
                )
              }
              if (transient) return yield* Effect.fail(transient)
            } else {
              for (let offset = 0; offset < job.chunks.length; offset += 16) {
                const chunks = job.chunks.slice(offset, offset + 16)
                const vectors = yield* embedManyEffect(
                  chunks.map((chunk) => chunk.text),
                  "passage"
                )
                // Await every issued mutation before recording the batch outcome.
                const batch = yield* Effect.forEach(
                  chunks,
                  (chunk, index) =>
                    attempt(() =>
                      ctx.runMutation(internal.jobs.saveEmbedding, {
                        id: chunk._id,
                        revisionId: job.revisionId,
                        embedding: vectors[index],
                        model: EMBEDDING_MODEL,
                      })
                    ).pipe(Effect.exit),
                  { concurrency: 16 }
                )
                const failures = batch.filter(Exit.isFailure)
                if (failures.length)
                  return yield* Effect.failCause(
                    failures.reduce(
                      (cause, exit) => Cause.parallel(cause, exit.cause),
                      Cause.empty as Cause.Cause<AppError>
                    )
                  )
              }
            }
          })
        )
        if (Exit.isSuccess(outcome)) {
          yield* attempt(() =>
            ctx.runMutation(internal.jobs.finish, {
              jobId: job._id,
              attempt: job.attempt,
            })
          )
        } else {
          const error = failureError(outcome.cause)
          yield* attempt(() =>
            ctx.runMutation(internal.jobs.finish, {
              jobId: job._id,
              attempt: job.attempt,
              error: error.message.slice(0, 300),
              blocked: error.code === "NOT_CONFIGURED",
              terminal: !isTransient(error),
            })
          )
          if (!isExpectedCause(outcome.cause))
            return yield* Effect.failCause(outcome.cause)
        }
      }),
      "background_job"
    ),
})
export const indexNow = internalAction({
  args: {},
  handler: (ctx): Promise<void> =>
    runConvex(
      Effect.gen(function* () {
        const site = process.env.SITE_URL,
          key = process.env.INDEXNOW_KEY
        if (!site || !key || !site.startsWith("https://")) return
        const rows = yield* attempt(() =>
          ctx.runQuery(internal.jobs.pendingIndex, {})
        )
        if (!rows.length) return
        const sentAt = Date.now()
        const outcome = yield* Effect.exit(
          Effect.gen(function* () {
            const response = yield* fetchEffect(
              () =>
                fetch("https://api.indexnow.org/indexnow", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    host: new URL(site).host,
                    key,
                    keyLocation: `${site}/indexnow-key.txt`,
                    urlList: rows.map((r) => r.url),
                  }),
                  signal: AbortSignal.timeout(10_000),
                }),
              "IndexNow"
            )
            if (!response.ok)
              return yield* Effect.fail(
                externalError({ status: response.status }, "IndexNow") ??
                  appError("BAD_GATEWAY", "IndexNow rejected the request.")
              )
          })
        )
        yield* attempt(() =>
          ctx.runMutation(internal.jobs.indexResult, {
            ids: rows.map((r) => r._id),
            sentAt,
            success: Exit.isSuccess(outcome),
            terminal:
              Exit.isFailure(outcome) &&
              !isTransient(failureError(outcome.cause)),
          })
        )
        if (Exit.isFailure(outcome) && !isExpectedCause(outcome.cause))
          return yield* Effect.failCause(outcome.cause)
      }),
      "indexnow"
    ),
})
