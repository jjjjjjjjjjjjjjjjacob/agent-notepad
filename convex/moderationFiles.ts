"use node"
import { Effect } from "effect"
import { appError } from "../lib/errors"
import { attempt, attemptSync, runConvex } from "../lib/effects"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { screenTextEffect } from "../lib/injection-screening"
import { digest, stableJson } from "../lib/hash"
export const privatize = internalAction({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }): Promise<void> => {
    return runConvex(
      Effect.gen(function* () {
        const file = yield* attempt(() =>
          ctx.runQuery(internal.moderationFileRecords.read, {
            fileId,
          })
        )
        if (!file?.storageId || file.privateStorage) return
        const bytes = yield* attempt(() => ctx.storage.get(file.storageId!))
        if (!bytes) return
        const storageId = yield* attempt(() => ctx.storage.store(bytes))
        const moved = yield* attempt(() =>
          ctx.runMutation(internal.moderationFileRecords.moved, {
            fileId,
            oldStorageId: file.storageId!,
            storageId,
          })
        )
        yield* attempt(() =>
          ctx.storage.delete(moved ? file.storageId! : storageId)
        )
      }),
      "file_privatize"
    )
  },
})
export const scan = internalAction({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }): Promise<void> => {
    return runConvex(
      Effect.gen(function* () {
        if (
          process.env.MODERATION_ENABLED !== "true" &&
          process.env.MODERATION_SCAN_ONLY !== "true"
        )
          return
        yield* attempt(() =>
          ctx.runAction(internal.moderationFiles.privatize, { fileId })
        )
        const file = yield* attempt(() =>
          ctx.runQuery(internal.moderationFileRecords.read, {
            fileId,
          })
        )
        if (
          !file?.storageId ||
          file.suppressed ||
          file.scanStatus === "clear" ||
          file.quarantined
        )
          return
        if (
          !/^(text\/(plain|markdown)|application\/json)(;|$)/i.test(
            file.contentType
          ) ||
          (file.size ?? Infinity) > 600000
        )
          return // Human review, no public delivery.
        const bytes = yield* attempt(() => ctx.storage.get(file.storageId!))
        if (!bytes) return
        const text = yield* attempt(() => bytes.arrayBuffer()).pipe(
          Effect.flatMap((buffer) =>
            attemptSync(
              () => new TextDecoder("utf-8", { fatal: true }).decode(buffer),
              (error) =>
                error instanceof TypeError
                  ? appError("VALIDATION", "File is not valid UTF-8.")
                  : undefined
            )
          ),
          Effect.catchTag("AppError", () => Effect.succeed(null))
        )
        if (text === null) return
        yield* Effect.gen(function* () {
          const result = yield* screenTextEffect(text)
          if (result.confidence !== "NONE") {
            const ipHash = yield* attempt(() =>
              ctx.runQuery(internal.moderationFileRecords.network, {
                fileId,
                agentId: file.agentId,
              })
            )
            const flagged = yield* attempt(() =>
              ctx.runMutation(internal.screeningResults.flag, {
                agentId: file.agentId,
                fingerprint: digest(text),
                content: text,
                operation: "file_upload",
                assessment: stableJson(result),
                confidence: result.confidence,
                ...(ipHash ? { ipHash } : {}),
              })
            )
            if (flagged.cleared)
              yield* attempt(() =>
                ctx.runMutation(internal.moderationFileRecords.markScan, {
                  fileId,
                  storageId: file.storageId!,
                  clear: true,
                })
              )
            else
              yield* attempt(() =>
                ctx.runMutation(internal.screeningResults.attachFile, {
                  caseId: flagged.caseId,
                  fileId,
                  quarantine: result.confidence === "HIGH",
                })
              )
          } else
            yield* attempt(() =>
              ctx.runMutation(internal.moderationFileRecords.markScan, {
                fileId,
                storageId: file.storageId!,
                clear: result.confidence === "NONE",
              })
            )
        }).pipe(Effect.catchTag("AppError", () => Effect.void))
      }),
      "file_scan"
    )
  },
})
