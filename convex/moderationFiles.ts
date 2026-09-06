"use node"
import { internalAction } from "./_generated/server"
import { internal } from "./_generated/api"
import { v } from "convex/values"
import { screenText } from "../lib/injection-screening"
import { digest, stableJson } from "../lib/hash"
export const privatize = internalAction({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    const file = await ctx.runQuery(internal.moderationFileRecords.read, {
      fileId,
    })
    if (!file?.storageId || file.privateStorage) return
    const bytes = await ctx.storage.get(file.storageId)
    if (!bytes) return
    const storageId = await ctx.storage.store(bytes)
    const moved = await ctx.runMutation(internal.moderationFileRecords.moved, {
      fileId,
      oldStorageId: file.storageId,
      storageId,
    })
    await ctx.storage.delete(moved ? file.storageId : storageId)
  },
})
export const scan = internalAction({
  args: { fileId: v.id("files") },
  handler: async (ctx, { fileId }) => {
    if (
      process.env.MODERATION_ENABLED !== "true" &&
      process.env.MODERATION_SCAN_ONLY !== "true"
    )
      return
    await ctx.runAction(internal.moderationFiles.privatize, { fileId })
    const file = await ctx.runQuery(internal.moderationFileRecords.read, {
      fileId,
    })
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
    const bytes = await ctx.storage.get(file.storageId)
    if (!bytes) return
    let text: string
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        await bytes.arrayBuffer()
      )
    } catch {
      return
    }
    try {
      const result = await screenText(text)
      if (result.confidence !== "NONE") {
        const ipHash = await ctx.runQuery(
          internal.moderationFileRecords.network,
          { fileId, agentId: file.agentId }
        )
        const flagged = await ctx.runMutation(internal.screeningResults.flag, {
          agentId: file.agentId,
          fingerprint: digest(text),
          content: text,
          operation: "file_upload",
          assessment: stableJson(result),
          confidence: result.confidence,
          ...(ipHash ? { ipHash } : {}),
        })
        if (flagged.cleared)
          await ctx.runMutation(internal.moderationFileRecords.markScan, {
            fileId,
            storageId: file.storageId,
            clear: true,
          })
        else
          await ctx.runMutation(internal.screeningResults.attachFile, {
            caseId: flagged.caseId,
            fileId,
            quarantine: result.confidence === "HIGH",
          })
      } else
        await ctx.runMutation(internal.moderationFileRecords.markScan, {
          fileId,
          storageId: file.storageId,
          clear: result.confidence === "NONE",
        })
    } catch {
      /* File stays private until a successful retry or human review. */
    }
  },
})
