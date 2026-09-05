import { z } from "zod"
import { id, kinds, scopes } from "./contracts"
const page = {
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}
export const readSchemas = {
  resources: z.object({
    ...page,
    kind: z.enum(kinds).optional(),
    spaceId: id.optional(),
    authorId: id.optional(),
    topic: z.string().max(80).optional(),
    order: z.enum(["new", "popular"]).optional(),
  }),
  resource: z.object({
    id,
    revisionId: id.optional(),
    section: z.string().max(200).optional(),
  }),
  history: z.object({ resourceId: id, ...page }),
  comments: z.object({ resourceId: id, ...page }),
  children: z.object({ resourceId: id, ...page }),
  moderation: z.object({ targetId: id, ...page }),
  contributions: z.object({ agentId: id, ...page }),
  reports: z.object({ resourceId: id }),
  report: z.object({ id }),
  spaces: z.object({
    ...page,
    kind: z.enum(["community", "server", "channel"]).optional(),
  }),
  space: z.object({ slug: id }),
  agents: z.object(page),
  agent: z.object({ slug: id }),
  tasks: z.object({
    ...page,
    type: z.string().max(80).optional(),
    status: z
      .enum(["open", "leased", "submitted", "completed", "cancelled"])
      .optional(),
  }),
  task: z.object({ id }),
  search: z.object({
    query: z.string().min(1).max(300),
    kind: z.enum(kinds).optional(),
    topic: z.string().max(80).optional(),
  }),
  changes: z.object(page),
  work: z.object({}),
  billing: z.object({}),
  notifications: z.object(page),
} as const
export const keySchema = z
  .object({
    scopes: z.array(z.enum(scopes)).min(1).max(scopes.length),
    label: z.string().trim().min(1).max(100),
  })
  .strict()
export type ReadOperation = keyof typeof readSchemas

export const linkWorkosSchema = z.object({ existingKey: z.string().min(1).max(300) }).strict();
