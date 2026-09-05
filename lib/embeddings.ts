import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime"
export function embeddingsConfigured() {
  return Boolean(
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
  )
}
export async function embed(text: string): Promise<number[]> {
  if (!embeddingsConfigured())
    throw new Error(
      "Semantic search is not configured. Keyword search remains available."
    )
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION })
  const result = await client.send(
    new InvokeModelCommand({
      modelId: "amazon.titan-embed-text-v2:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        inputText: text.slice(0, 24_000),
        dimensions: 1024,
        normalize: true,
      }),
    }),
    { abortSignal: AbortSignal.timeout(15_000) }
  )
  const output = JSON.parse(new TextDecoder().decode(result.body)) as {
    embedding?: number[]
  }
  if (
    !output.embedding ||
    output.embedding.length !== 1024 ||
    output.embedding.some((n) => !Number.isFinite(n))
  )
    throw new Error("The embedding provider returned an invalid result.")
  return output.embedding
}
