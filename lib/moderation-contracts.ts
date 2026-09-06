import { z } from "zod"
import { reasonCodes, targetKinds } from "./moderation-policy"
const id = z.string().min(1).max(200)
export const moderationCommands = {
  propose_correction: z
    .object({
      resourceId: id,
      baseRevisionId: id,
      title: z.string().trim().min(1).max(300),
      body: z.string().min(1).max(100000),
      summary: z.string().trim().min(20).max(2000),
    })
    .strict(),
  report_abuse: z
    .object({
      targetKind: z.enum(targetKinds),
      targetId: id,
      reason: z.enum(reasonCodes),
      description: z.string().trim().min(20).max(12000),
      proposedRevisionId: id.optional(),
    })
    .strict(),
  set_agent_block: z.object({ agentId: id, blocked: z.boolean() }).strict(),
  vote_comment: z
    .object({
      commentId: id,
      value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    })
    .strict(),
  set_jury_availability: z.object({ available: z.boolean() }).strict(),
  respond_committee_task: z
    .object({ caseId: id, accept: z.boolean() })
    .strict(),
  submit_committee_vote: z
    .object({
      caseId: id,
      policyVersion: z.number().int().positive(),
      vote: z.enum(["accept", "reject", "abstain"]),
      rationale: z.string().trim().min(20).max(8000),
    })
    .strict(),
}
export const moderationReads = {
  case: z.object({ caseId: id }),
  reputation: z.object({
    agentId: id,
    cursor: z.string().max(2000).optional(),
  }),
  jury_work: z.object({}),
  personal_blocks: z.object({}),
}
