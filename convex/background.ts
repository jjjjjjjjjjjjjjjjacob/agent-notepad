"use node"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { safeFetchText, plainText } from "../lib/safe-fetch"
import { digest } from "../lib/hash"
import { embedMany, embeddingsConfigured } from "../lib/embeddings"
import { EMBEDDING_MODEL } from "../lib/embedding-config"

export const run = internalAction({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args): Promise<void> => {
    const job = await ctx.runMutation(internal.jobs.start, args)
    if (!job) return
    try {
      if (job.kind === "source") {
        for (const citation of job.revision.citations) {
          try {
            const result = await safeFetchText(citation.url)
            const text = plainText(result.text)
            await ctx.runMutation(internal.jobs.saveSource, {
              resourceId: job.resourceId,
              revisionId: job.revisionId,
              url: citation.url,
              title: citation.title,
              status: "retrieved",
              fingerprint: digest(result.text),
              excerpt: text.split(/\s+/).slice(0, 24).join(" "),
            })
          } catch (error) {
            await ctx.runMutation(internal.jobs.saveSource, {
              resourceId: job.resourceId,
              revisionId: job.revisionId,
              url: citation.url,
              title: citation.title,
              status: "unavailable",
              error:
                error instanceof Error
                  ? error.message.slice(0, 300)
                  : "Source retrieval failed.",
            })
          }
        }
      } else {
        if (!embeddingsConfigured()) {
          await ctx.runMutation(internal.jobs.finish, {
            jobId: job._id,
            attempt: job.attempt,
            error:
              "Configure EMBEDDING_SERVICE_URL and EMBEDDING_SERVICE_TOKEN to enable semantic indexing.",
            blocked: true,
          })
          return
        }
        for (let offset = 0; offset < job.chunks.length; offset += 16) {
          const chunks = job.chunks.slice(offset, offset + 16)
          const vectors = await embedMany(
            chunks.map((chunk) => chunk.text),
            "passage"
          )
          const batch = await Promise.allSettled(
            chunks.map(async (chunk, index) =>
              ctx.runMutation(internal.jobs.saveEmbedding, {
                id: chunk._id,
                revisionId: job.revisionId,
                embedding: vectors[index],
                model: EMBEDDING_MODEL,
              })
            )
          )
          if (batch.some((result) => result.status === "rejected"))
            throw new Error("An embedding batch failed.")
        }
      }
      await ctx.runMutation(internal.jobs.finish, {
        jobId: job._id,
        attempt: job.attempt,
      })
    } catch {
      await ctx.runMutation(internal.jobs.finish, {
        jobId: job._id,
        attempt: job.attempt,
        error:
          "Background processing failed; retrying within the configured limit.",
      })
    }
  },
})
export const indexNow = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const site = process.env.SITE_URL
    const key = process.env.INDEXNOW_KEY
    if (!site || !key || !site.startsWith("https://")) return
    const rows = await ctx.runQuery(internal.jobs.pendingIndex, {})
    if (!rows.length) return
    const sentAt = Date.now()
    try {
      const response = await fetch("https://api.indexnow.org/indexnow", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host: new URL(site).host,
          key,
          keyLocation: `${site}/indexnow-key.txt`,
          urlList: rows.map((r) => r.url),
        }),
        signal: AbortSignal.timeout(10_000),
      })
      await ctx.runMutation(internal.jobs.indexResult, {
        ids: rows.map((r) => r._id),
        sentAt,
        success: response.ok,
      })
    } catch {
      await ctx.runMutation(internal.jobs.indexResult, {
        ids: rows.map((r) => r._id),
        sentAt,
        success: false,
      })
    }
  },
})
