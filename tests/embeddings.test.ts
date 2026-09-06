import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { embed, embedMany, embeddingsConfigured } from "../lib/embeddings"
import { EMBEDDING_DIMENSIONS, EMBEDDING_MODEL } from "../lib/embedding-config"

const fetchMock = vi.fn()
const vector = [1, ...Array<number>(EMBEDDING_DIMENSIONS - 1).fill(0)]
function result(embeddings: unknown[] = [vector], model = EMBEDDING_MODEL) {
  return Response.json({ model, dimensions: EMBEDDING_DIMENSIONS, embeddings })
}
beforeEach(() => {
  vi.stubEnv("EMBEDDING_SERVICE_URL", "https://embeddings.example.test")
  vi.stubEnv("EMBEDDING_SERVICE_TOKEN", "test-service-secret")
  vi.stubGlobal("fetch", fetchMock.mockReset())
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

it("batches passages in order and sends the model and input type without AWS credentials", async () => {
  vi.stubEnv("AWS_REGION", "")
  fetchMock.mockResolvedValue(result([vector, vector]))
  expect(embeddingsConfigured()).toBe(true)
  expect(await embedMany(["first", "second"], "passage")).toEqual([
    vector,
    vector,
  ])
  expect(fetchMock).toHaveBeenCalledTimes(1)
  const [url, options] = fetchMock.mock.calls[0]
  expect(url).toBe("https://embeddings.example.test/embed")
  expect(JSON.parse(options.body)).toEqual({
    texts: ["first", "second"],
    input_type: "passage",
    model: EMBEDDING_MODEL,
  })
  expect(options.headers.Authorization).toBe("Bearer test-service-secret")
  expect(options.redirect).toBe("error")
})
it("marks query inputs for the service's query instruction", async () => {
  fetchMock.mockResolvedValue(result())
  expect(await embed("giant rodents")).toEqual(vector)
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).input_type).toBe("query")
})
it.each([
  result([Array(1024).fill(0)]),
  result([Array(384).fill(0)]),
  result([Array(384).fill("1")]),
  result([vector], "different-model"),
  result([]),
  new Response("private error from upstream", { status: 503 }),
])(
  "rejects incompatible models, malformed batches and failed responses",
  async (response) => {
    fetchMock.mockResolvedValue(response)
    await expect(embed("water")).rejects.toThrow()
  }
)
it("fails closed for unsafe service URLs and missing secrets", async () => {
  for (const url of [
    "http://remote.example.test",
    "https://user:password@example.test",
    "not a url",
  ]) {
    vi.stubEnv("EMBEDDING_SERVICE_URL", url)
    expect(embeddingsConfigured()).toBe(false)
    await expect(embed("water")).rejects.toThrow()
  }
  vi.stubEnv("EMBEDDING_SERVICE_URL", "http://127.0.0.1:8088")
  expect(embeddingsConfigured()).toBe(true)
  vi.stubEnv("EMBEDDING_SERVICE_TOKEN", "")
  expect(embeddingsConfigured()).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})
it("rejects oversized batches without contacting the provider", async () => {
  await expect(embedMany(Array(17).fill("water"), "passage")).rejects.toThrow()
  await expect(embedMany(["water".repeat(3000)], "passage")).rejects.toThrow()
  expect(fetchMock).not.toHaveBeenCalled()
})
