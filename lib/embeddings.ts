import { Effect } from "effect"
import { appError, expectedError, externalError } from "./errors"
import { attemptSync, fetchEffect, responseJson, runEffect } from "./effects"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-config"

function configuration() {
  const endpoint = process.env.EMBEDDING_SERVICE_URL
  const token = process.env.EMBEDDING_SERVICE_TOKEN
  if (!endpoint || !token) return null
  const parsed = URL.parse(endpoint)
  if (!parsed)
    throw appError("NOT_CONFIGURED", "Embedding service URL is invalid.")
  const url = parsed
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  )
    throw appError(
      "NOT_CONFIGURED",
      "Embedding service requires HTTPS (HTTP is allowed only on loopback)."
    )
  return { url: `${url.href.replace(/\/$/, "")}/embed`, token }
}

export function embeddingsConfigured() {
  // Invalid configuration must not take keyword retrieval down.
  try {
    return configuration() !== null
  } catch (error) {
    if (expectedError(error)?.code === "NOT_CONFIGURED") return false
    throw error
  }
}

export function embedManyEffect(
  texts: string[],
  inputType: "query" | "passage"
) {
  return Effect.gen(function* () {
    const config = yield* attemptSync(configuration)
    if (!config)
      return yield* Effect.fail(
        appError("NOT_CONFIGURED", "Semantic retrieval is not configured.")
      )
    if (
      !texts.length ||
      texts.length > 16 ||
      texts.some((text) => !text.trim() || text.length > 12000)
    )
      return yield* Effect.fail(
        appError("VALIDATION", "Invalid embedding batch.")
      )
    const response = yield* fetchEffect(
      () =>
        fetch(config.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.token}`,
          },
          body: JSON.stringify({
            texts,
            input_type: inputType,
            model: EMBEDDING_MODEL,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(30_000),
        }),
      "Embedding service"
    )
    if (!response.ok)
      return yield* Effect.fail(
        externalError({ status: response.status }, "Embedding service") ??
          appError(
            "BAD_GATEWAY",
            "Embedding service returned an invalid status."
          )
      )
    const output = (yield* responseJson(response, "Embedding service")) as {
      model?: string
      dimensions?: number
      embeddings?: unknown[]
    }
    if (
      !output ||
      output.model !== EMBEDDING_MODEL ||
      output.dimensions !== EMBEDDING_DIMENSIONS ||
      !Array.isArray(output.embeddings) ||
      output.embeddings.length !== texts.length
    )
      return yield* Effect.fail(
        appError(
          "BAD_GATEWAY",
          "Embedding service returned an incompatible model or batch."
        )
      )
    return yield* Effect.forEach(output.embeddings, (vector) => {
      if (
        !Array.isArray(vector) ||
        vector.length !== EMBEDDING_DIMENSIONS ||
        vector.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
        Math.abs(Math.hypot(...vector) - 1) > 0.01
      )
        return Effect.fail(
          appError(
            "BAD_GATEWAY",
            "Embedding service returned an invalid vector."
          )
        )
      return Effect.succeed(vector as number[])
    })
  })
}

export const embedMany = (texts: string[], inputType: "query" | "passage") =>
  runEffect(embedManyEffect(texts, inputType))
export const embedEffect = (text: string) =>
  embedManyEffect([text], "query").pipe(Effect.map((vectors) => vectors[0]))

export async function embed(text: string): Promise<number[]> {
  return (await embedMany([text], "query"))[0]
}
