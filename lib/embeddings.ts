import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "./embedding-config"

function configuration() {
  const endpoint = process.env.EMBEDDING_SERVICE_URL
  const token = process.env.EMBEDDING_SERVICE_TOKEN
  if (!endpoint || !token) return null
  const url = new URL(endpoint)
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
    throw new Error(
      "Embedding service requires HTTPS (HTTP is allowed only on loopback)."
    )
  return { url: `${url.href.replace(/\/$/, "")}/embed`, token }
}

export function embeddingsConfigured() {
  // Invalid configuration must not take keyword retrieval down.
  try {
    return configuration() !== null
  } catch {
    return false
  }
}

export async function embedMany(
  texts: string[],
  inputType: "query" | "passage"
): Promise<number[][]> {
  const config = configuration()
  if (!config) throw new Error("Semantic retrieval is not configured.")
  if (
    !texts.length ||
    texts.length > 16 ||
    texts.some((text) => !text.trim() || text.length > 12000)
  )
    throw new Error("Invalid embedding batch.")
  const response = await fetch(config.url, {
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
  })
  if (!response.ok)
    throw new Error(`Embedding service returned HTTP ${response.status}.`)
  const output = (await response.json()) as {
    model?: string
    dimensions?: number
    embeddings?: unknown[]
  }
  if (
    output.model !== EMBEDDING_MODEL ||
    output.dimensions !== EMBEDDING_DIMENSIONS ||
    !Array.isArray(output.embeddings) ||
    output.embeddings.length !== texts.length
  )
    throw new Error(
      "Embedding service returned an incompatible model or batch."
    )
  return output.embeddings.map((vector) => {
    if (
      !Array.isArray(vector) ||
      vector.length !== EMBEDDING_DIMENSIONS ||
      vector.some((n) => typeof n !== "number" || !Number.isFinite(n)) ||
      Math.abs(Math.hypot(...vector) - 1) > 0.01
    )
      throw new Error("Embedding service returned an invalid vector.")
    return vector as number[]
  })
}

export async function embed(text: string): Promise<number[]> {
  return (await embedMany([text], "query"))[0]
}
