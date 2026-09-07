import { Effect } from "effect"
import { z } from "zod"
import { appError } from "./errors"
import { external, runEffect } from "./effects"
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime"
export type ScanResult = {
  confidence: "HIGH" | "MEDIUM" | "LOW" | "NONE"
  guardrailId: string
  guardrailVersion: string
}
const scanResponse = z.object({
  assessments: z
    .array(
      z.object({
        contentPolicy: z
          .object({
            filters: z
              .array(
                z.object({
                  type: z.string(),
                  filterStrength: z.string(),
                  confidence: z.string(),
                })
              )
              .optional(),
          })
          .optional(),
      })
    )
    .optional(),
  guardrailCoverage: z
    .object({
      textCharacters: z
        .object({ guarded: z.number().finite().nonnegative() })
        .optional(),
    })
    .optional(),
})
export function screenTextEffect(text: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const guardrailId = process.env.MODERATION_GUARDRAIL_ID,
        guardrailVersion = process.env.MODERATION_GUARDRAIL_VERSION
      if (
        !guardrailId ||
        !guardrailVersion ||
        !/^[1-9][0-9]*$/.test(guardrailVersion) ||
        !process.env.AWS_REGION
      )
        return yield* Effect.fail(
          appError(
            "NOT_CONFIGURED",
            "Configure a published Bedrock prompt-attack guardrail version."
          )
        )
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () => new BedrockRuntimeClient({ region: process.env.AWS_REGION })
        ),
        (client) => Effect.sync(() => client.destroy())
      )
      const confidenceOrder = ["NONE", "LOW", "MEDIUM", "HIGH"] as const
      let rank = 0
      // Scan the full value, with overlap across provider-sized chunks. Never truncate.
      for (let offset = 0; offset < text.length; offset += 7500) {
        const chunk = text.slice(offset, offset + 8000)
        const result = yield* external(
          () =>
            client.send(
              new ApplyGuardrailCommand({
                guardrailIdentifier: guardrailId,
                guardrailVersion,
                source: "INPUT",
                outputScope: "FULL",
                content: [
                  { text: { text: chunk, qualifiers: ["guard_content"] } },
                ],
              }),
              { abortSignal: AbortSignal.timeout(15000) }
            ),
          "Content screening"
        )
        const parsed = scanResponse.safeParse(result)
        if (!parsed.success)
          return yield* Effect.fail(
            appError("BAD_GATEWAY", "Guardrail returned an invalid response.")
          )
        const response = parsed.data
        const filters =
          response.assessments
            ?.flatMap((a) => a.contentPolicy?.filters ?? [])
            .filter((f) => f.type === "PROMPT_ATTACK") ?? []
        if (
          !filters.length ||
          !response.guardrailCoverage ||
          (response.guardrailCoverage.textCharacters?.guarded ?? 0) <
            chunk.length
        )
          return yield* Effect.fail(
            appError(
              "BAD_GATEWAY",
              "Guardrail did not evaluate all text for prompt attacks."
            )
          )
        for (const filter of filters) {
          if (filter.filterStrength !== "LOW")
            return yield* Effect.fail(
              appError(
                "BAD_GATEWAY",
                "Prompt-attack filter must use LOW strength."
              )
            )
          const confidence = confidenceOrder.indexOf(
            filter.confidence as (typeof confidenceOrder)[number]
          )
          if (confidence < 0)
            return yield* Effect.fail(
              appError(
                "BAD_GATEWAY",
                "Guardrail returned an unrecognized confidence."
              )
            )
          rank = Math.max(rank, confidence)
        }
      }
      return {
        confidence: confidenceOrder[rank],
        guardrailId,
        guardrailVersion,
      }
    })
  )
}
export const screenText = (text: string): Promise<ScanResult> =>
  runEffect(screenTextEffect(text))
