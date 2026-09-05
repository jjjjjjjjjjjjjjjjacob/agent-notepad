import { v } from "convex/values"
import { internalMutation } from "./_generated/server"
import {
  commandSchemas,
  operationScope,
  type Operation,
} from "../lib/contracts"
import { digest, stableJson } from "../lib/hash"
import {
  asId,
  fail,
  metric,
  rateLimit,
  requireAgent,
  resource,
} from "./lib/core"
import * as wiki from "./ops/wiki"
import * as social from "./ops/social"
import * as tasks from "./ops/tasks"
import * as moderation from "./ops/moderation"
import { agentCredential } from "./lib/agentIdentity"
import { agentBillingAccess } from "./lib/billingAccess"

export const execute = internalMutation({
  args: {
    token: agentCredential,
    operation: v.string(),
    input: v.any(),
    idempotencyKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    if (!Object.hasOwn(commandSchemas, args.operation))
      fail("VALIDATION", "Unknown operation.")
    const operation = args.operation as Operation
    const parsed = commandSchemas[operation].safeParse(args.input)
    if (!parsed.success)
      fail(
        "VALIDATION",
        parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")
      )
    let scope = operationScope[operation]
    if (
      operation === "publish" &&
      "kind" in parsed.data &&
      parsed.data.kind === "wiki"
    )
      scope = "wiki:write"
    if (
      operation === "edit" &&
      "id" in parsed.data &&
      (await resource(ctx, parsed.data.id)).kind === "wiki"
    )
      scope = "wiki:write"
    const { agent, key } = await requireAgent(ctx, args.token, scope)
    if (args.idempotencyKey && args.idempotencyKey.length > 128)
      fail("VALIDATION", "Idempotency keys are limited to 128 characters.")
    const fingerprint = digest(stableJson({ operation, input: parsed.data }))
    const receipt = args.idempotencyKey
      ? await ctx.db
          .query("receipts")
          .withIndex("by_agent_key", (q) =>
            q.eq("agentId", agent._id).eq("key", args.idempotencyKey!)
          )
          .unique()
      : null
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        fail("CONFLICT", "That idempotency key belongs to a different request.")
      return receipt.result
    }
    const billing = await agentBillingAccess(ctx, agent)
    await rateLimit(ctx, `write:${agent._id}`, billing.writeLimitPerMinute)
    let result: unknown
    switch (operation) {
      case "publish":
        result = await wiki.publish(
          ctx,
          agent,
          commandSchemas.publish.parse(args.input)
        )
        break
      case "edit":
        result = await wiki.edit(
          ctx,
          agent,
          commandSchemas.edit.parse(args.input)
        )
        break
      case "revert":
        result = await wiki.revert(
          ctx,
          agent,
          commandSchemas.revert.parse(args.input)
        )
        break
      case "review_pending":
        result = await wiki.reviewPending(
          ctx,
          agent,
          commandSchemas.review_pending.parse(args.input)
        )
        break
      case "create_space":
        result = await social.createSpace(
          ctx,
          agent,
          commandSchemas.create_space.parse(args.input)
        )
        break
      case "comment":
        result = await social.comment(
          ctx,
          agent,
          commandSchemas.comment.parse(args.input)
        )
        break
      case "vote":
        result = await social.vote(
          ctx,
          agent,
          commandSchemas.vote.parse(args.input)
        )
        break
      case "profile":
        result = await social.profile(
          ctx,
          agent,
          commandSchemas.profile.parse(args.input)
        )
        break
      case "watch":
        result = await social.watch(
          ctx,
          agent,
          commandSchemas.watch.parse(args.input)
        )
        break
      case "create_upload":
        result = await social.createUpload(
          ctx,
          agent,
          commandSchemas.create_upload.parse(args.input)
        )
        break
      case "finish_upload":
        result = await social.finishUpload(
          ctx,
          agent,
          commandSchemas.finish_upload.parse(args.input)
        )
        break
      case "request_work":
        result = await tasks.requestWork(
          ctx,
          agent,
          commandSchemas.request_work.parse(args.input)
        )
        break
      case "renew_work":
        result = await tasks.renewWork(
          ctx,
          agent,
          commandSchemas.renew_work.parse(args.input)
        )
        break
      case "release_work":
        result = await tasks.releaseWork(
          ctx,
          agent,
          commandSchemas.release_work.parse(args.input)
        )
        break
      case "submit_work":
        result = await tasks.submitWork(
          ctx,
          agent,
          commandSchemas.submit_work.parse(args.input)
        )
        break
      case "raise_issue":
        result = await tasks.raiseIssue(
          ctx,
          agent,
          commandSchemas.raise_issue.parse(args.input)
        )
        break
      case "protect":
        result = await moderation.protect(
          ctx,
          agent,
          commandSchemas.protect.parse(args.input)
        )
        break
      case "suppress":
        result = await moderation.suppress(
          ctx,
          agent,
          commandSchemas.suppress.parse(args.input)
        )
        break
      case "moderate_agent":
        result = await moderation.moderateAgent(
          ctx,
          agent,
          commandSchemas.moderate_agent.parse(args.input)
        )
        break
      case "redact_comment":
        result = await moderation.redactComment(
          ctx,
          agent,
          commandSchemas.redact_comment.parse(args.input)
        )
        break
      case "redact_space":
        result = await moderation.redactSpace(
          ctx,
          agent,
          commandSchemas.redact_space.parse(args.input)
        )
        break
      case "grant_role":
        result = await moderation.grantRole(
          ctx,
          agent,
          commandSchemas.grant_role.parse(args.input)
        )
        break
      case "revoke_key": {
        const input = commandSchemas.revoke_key.parse(args.input)
        const target = await ctx.db.get(asId(ctx, "keys", input.keyId))
        if (!target || target.agentId !== agent._id)
          fail("NOT_FOUND", "Key not found.")
        await ctx.db.patch(target._id, { revokedAt: Date.now() })
        result = {
          keyId: target._id,
          revoked: true,
          currentKey: target._id === key?._id,
        }
        break
      }
    }
    if (args.idempotencyKey)
      await ctx.db.insert("receipts", {
        agentId: agent._id,
        key: args.idempotencyKey,
        fingerprint,
        result,
      })
    await metric(ctx, `write.${operation}`)
    return result
  },
})
