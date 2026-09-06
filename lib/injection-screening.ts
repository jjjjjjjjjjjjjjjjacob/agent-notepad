import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime"
export type ScanResult = {
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE"
  guardrailId: string
  guardrailVersion: string
}
export async function screenText(text: string): Promise<ScanResult> {
  const guardrailId = process.env.MODERATION_GUARDRAIL_ID,
    guardrailVersion = process.env.MODERATION_GUARDRAIL_VERSION
  if (
    !guardrailId ||
    !guardrailVersion ||
    !/^[1-9][0-9]*$/.test(guardrailVersion) ||
    !process.env.AWS_REGION
  )
    throw new Error(
      "Configure a published Bedrock prompt-attack guardrail version."
    )
  const client = new BedrockRuntimeClient({ region: process.env.AWS_REGION })
  const confidenceOrder = ["NONE", "LOW", "MEDIUM", "HIGH"] as const
  let rank = 0
  // Scan the full value, with overlap across provider-sized chunks. Never truncate.
  for (let offset = 0; offset < text.length; offset += 7500) {
    const chunk = text.slice(offset, offset + 8000)
    const response = await client.send(
      new ApplyGuardrailCommand({
        guardrailIdentifier: guardrailId,
        guardrailVersion,
        source: "INPUT",
        outputScope: "FULL",
        content: [{ text: { text: chunk, qualifiers: ["guard_content"] } }],
      }),
      { abortSignal: AbortSignal.timeout(15000) }
    )
    const filters =
      response.assessments
        ?.flatMap((a) => a.contentPolicy?.filters ?? [])
        .filter((f) => f.type === "PROMPT_ATTACK") ?? []
    if (
      !filters.length ||
      !response.guardrailCoverage ||
      (response.guardrailCoverage.textCharacters?.guarded ?? 0) < chunk.length
    )
      throw new Error("Guardrail did not evaluate all text for prompt attacks.")
    for (const filter of filters) {
      if (filter.filterStrength !== "LOW")
        throw new Error("Prompt-attack filter must use LOW strength.")
      const confidence = confidenceOrder.indexOf(
        filter.confidence as (typeof confidenceOrder)[number]
      )
      if (confidence < 0)
        throw new Error("Guardrail returned an unrecognized confidence.")
      rank = Math.max(rank, confidence)
    }
  }
  return { confidence: confidenceOrder[rank], guardrailId, guardrailVersion }
}
