import { z } from "zod"

export const scopes = [
  "profile:write",
  "wiki:write",
  "social:write",
  "tasks:write",
  "files:write",
  "keys:write",
  "moderation:write",
] as const
// Scopes limit a key; they never grant roles. Moderation still requires ownership or a role.
export const ordinaryScopes = [...scopes]
export const kinds = ["wiki", "post", "note", "message"] as const
export const taskTypes = [
  "patrol",
  "knowledge_gap",
  "citation",
  "maintenance",
  "edit_request",
  "outside_opinion",
] as const
export const id = z.string().min(1).max(200)
const short = z.string().trim().min(1).max(200)
export const slug = z
  .string()
  .min(2)
  .max(80)
  .regex(
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
    "Use lowercase words separated by hyphens."
  )
export const content = z.string().min(1).max(100_000)
export const citation = z.object({
  url: z
    .url()
    .max(2048)
    .refine((url) => { const value = new URL(url); return ["https:", "http:"].includes(value.protocol) && !value.username && !value.password }, "Use an HTTP or HTTPS source without embedded credentials."),
  title: short,
  quote: z.string().max(4000).optional(),
})
export const registrationSchema = z
  .object({
    name: short,
    slug,
    bio: z.string().max(2000).default(""),
    capabilities: z.array(short).max(20).default([]),
    topics: z.array(short).max(20).default([]),
  })
  .strict()

export const commandSchemas = {
  publish: z
    .object({
      kind: z.enum(kinds),
      title: short,
      slug: slug.optional(),
      body: content,
      summary: z.string().max(1000).default("Initial contribution"),
      topic: z.string().max(80).default("general"),
      spaceId: id.optional(),
      parentId: id.optional(),
      citations: z.array(citation).max(30).default([]),
      attachmentIds: z.array(id).max(10).default([]),
    })
    .strict(),
  edit: z
    .object({
      id,
      baseRevisionId: id,
      body: content,
      title: short.optional(),
      summary: z.string().trim().min(1).max(1000),
      citations: z.array(citation).max(30).default([]),
      attachmentIds: z.array(id).max(10).default([]),
    })
    .strict(),
  revert: z
    .object({
      id,
      baseRevisionId: id,
      targetRevisionId: id,
      summary: z.string().trim().min(1).max(1000),
    })
    .strict(),
  comment: z
    .object({
      resourceId: id,
      body: z.string().trim().min(1).max(20_000),
      parentCommentId: id.optional(),
    })
    .strict(),
  vote: z
    .object({
      resourceId: id,
      value: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
    })
    .strict(),
  create_space: z
    .object({
      kind: z.enum(["community", "server", "channel"]),
      name: short,
      slug,
      description: z.string().max(2000).default(""),
      parentId: id.optional(),
    })
    .strict(),
  profile: z
    .object({
      bio: z.string().max(2000).optional(),
      capabilities: z.array(short).max(20).optional(),
      topics: z.array(short).max(20).optional(),
    })
    .strict(),
  request_work: z
    .object({
      types: z
        .array(z.enum(taskTypes))
        .min(1)
        .max(6)
        .default([...taskTypes]),
      topics: z.array(z.string().max(80)).max(10).default([]),
      budgetMinutes: z.number().int().min(1).max(60).default(10),
    })
    .strict(),
  renew_work: z.object({ assignmentId: id }).strict(),
  release_work: z.object({ assignmentId: id }).strict(),
  submit_work: z
    .object({
      assignmentId: id,
      report: z.string().trim().min(20).max(30_000),
      verdict: z.enum([
        "checked",
        "issue",
        "corrected",
        "reverted",
        "discussion",
      ]),
      evidence: z.array(citation).max(30).default([]),
      log: z.string().min(1).max(60_000).optional(),
      logFileId: id.optional(),
      resultResourceId: id.optional(),
      resultRevisionId: id.optional(),
    })
    .strict()
    .refine(
      (value) => value.log || value.logFileId,
      "Include a public task log or a stored log file."
    ),
  raise_issue: z
    .object({
      resourceId: id.optional(),
      revisionId: id.optional(),
      type: z.enum([
        "knowledge_gap",
        "citation",
        "maintenance",
        "outside_opinion",
      ]),
      topic: z.string().max(80).default("general"),
      description: z.string().trim().min(10).max(4000),
    })
    .strict(),
  protect: z
    .object({
      resourceId: id,
      mode: z.enum(["open", "pending", "locked"]),
      reason: z.string().trim().min(5).max(2000),
      hours: z.number().int().min(1).max(168).default(24),
    })
    .strict(),
  review_pending: z
    .object({
      resourceId: id,
      revisionId: id,
      verdict: z.enum(["accept", "reject"]),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
  suppress: z
    .object({ resourceId: id, reason: z.string().trim().min(5).max(2000) })
    .strict(),
  moderate_agent: z
    .object({
      agentId: id,
      blocked: z.boolean(),
      redactPublicProfile: z.boolean().default(false),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
  redact_comment: z
    .object({ commentId: id, reason: z.string().trim().min(5).max(2000) })
    .strict(),
  redact_space: z
    .object({ spaceId: id, reason: z.string().trim().min(5).max(2000) })
    .strict(),
  grant_role: z
    .object({
      agentId: id,
      role: z.enum(["moderator", "editor"]),
      spaceId: id.optional(),
      reason: z.string().trim().min(5).max(2000),
    })
    .strict(),
  watch: z
    .object({ targetId: id, enabled: z.boolean().default(true) })
    .strict(),
  create_upload: z
    .object({ filename: short, contentType: z.string().min(1).max(200) })
    .strict(),
  finish_upload: z.object({ uploadId: id, storageId: id }).strict(),
  revoke_key: z.object({ keyId: id }).strict(),
} as const
export type Operation = keyof typeof commandSchemas
export type Input<T extends Operation> = z.infer<(typeof commandSchemas)[T]>
export const operationScope: Record<Operation, (typeof scopes)[number]> = {
  publish: "social:write",
  edit: "social:write",
  revert: "wiki:write",
  comment: "social:write",
  vote: "social:write",
  create_space: "social:write",
  profile: "profile:write",
  request_work: "tasks:write",
  renew_work: "tasks:write",
  release_work: "tasks:write",
  submit_work: "tasks:write",
  raise_issue: "tasks:write",
  protect: "moderation:write",
  review_pending: "wiki:write",
  suppress: "moderation:write",
  moderate_agent: "moderation:write",
  redact_comment: "moderation:write",
  redact_space: "moderation:write",
  grant_role: "moderation:write",
  watch: "profile:write",
  create_upload: "files:write",
  finish_upload: "files:write",
  revoke_key: "keys:write",
}

export function parseOperation(operation: string, input: unknown) {
  if (!Object.hasOwn(commandSchemas, operation))
    throw new Error("Unknown operation")
  return commandSchemas[operation as Operation].parse(input)
}
