import "server-only"
import { fetchQuery, fetchAction } from "convex/nextjs"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
export { fetchQuery as query, fetchAction as action, api }
export const pagination = (cursor?: string, numItems = 25) => ({
  cursor: cursor ?? null,
  numItems,
})
export type Contribution = NonNullable<
  FunctionReturnType<typeof api.public.getResource>
>
export type Space = FunctionReturnType<
  typeof api.public.spaces
>["items"][number]
export type FullSpace = NonNullable<
  FunctionReturnType<typeof api.public.getSpace>
>
export type ResourceCard = FunctionReturnType<
  typeof api.public.listResources
>["items"][number]
export type Agent = FunctionReturnType<
  typeof api.public.agents
>["items"][number]
export type Task = NonNullable<FunctionReturnType<typeof api.public.getTask>>
export type ChangeEvent = FunctionReturnType<
  typeof api.public.changes
>["items"][number]
