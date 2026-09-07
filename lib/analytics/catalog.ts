import { z } from "zod"

const id = z.string().regex(/^[a-zA-Z0-9:_-]{1,100}$/)
const count = z.number().int().nonnegative().max(1_000_000)
const duration = z.number().nonnegative().max(86_400_000)
const label = z.string().regex(/^[a-z][a-z0-9_.-]{0,79}$/)
export const resourceKind = z.enum(["wiki", "note", "post", "message"])
const common = {
  event_version: z.literal(1).default(1),
  delivery_attempt: z.number().int().min(1).max(3).optional(),
  environment: z.enum(["production", "verification"]),
  actor_type: z.enum(["human", "agent", "anonymous_api"]),
  transport: z.enum(["browser", "rest", "mcp", "internal"]),
  route: z
    .string()
    .regex(/^\/[a-z/\[\].-]*$/)
    .max(100)
    .optional(),
  view_id: z.uuid().optional(),
}
const event = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ ...common, ...shape })
export const searchSurface = z.enum([
  "header",
  "page",
  "home",
  "command",
  "map",
  "channels",
  "channel_navigation",
  "direct",
  "api",
])
const search = {
  search_id: z.uuid(),
  surface: searchSurface,
  query_length: count,
  kind: resourceKind.optional(),
  has_topic: z.boolean().optional(),
  has_community: z.boolean().optional(),
  sort_order: z.enum(["active", "new", "name"]).optional(),
  activity_window: z.enum(["all", "24h", "7d", "30d"]).optional(),
  include_empty: z.boolean().optional(),
}
export const searchMetadataSchema = z.object(search)
export const eventSchemas = {
  $pageview: event({
    referrer_domain: z
      .string()
      .regex(/^[a-zA-Z0-9.-]{1,253}$/)
      .optional(),
    campaign_source: label.optional(),
    campaign_medium: label.optional(),
    campaign_name: label.optional(),
  }),
  $pageleave: event({ active_ms: duration }),
  resource_viewed: event({
    resource_id: id.optional(),
    revision_id: id.optional(),
    kind: resourceKind.optional(),
    resource_mode: z
      .enum(["article", "discussion", "history", "diff"])
      .optional(),
  }),
  navigation_clicked: event({
    destination: z.string().max(300),
    location: z.enum(["header", "sidebar", "content", "command"]),
    action: z.enum([
      "navigate",
      "outbound",
      "download",
      "section",
      "pagination",
      "filter",
      "sort",
      "tab",
      "connect",
      "revision",
      "citation",
    ]),
  }),
  control_clicked: event({ action: label, surface: label.optional() }),
  search_submitted: event(search),
  search_results_viewed: event({
    ...search,
    result_count: count,
    mode: z.enum(["keyword", "hybrid", "local"]),
    duration_ms: duration,
  }),
  search_failed: event({ ...search, error_code: label }),
  search_result_clicked: event({
    search_id: z.uuid(),
    rank: count,
    resource_id: id.optional(),
    kind: resourceKind.optional(),
  }),
  reading_progress: event({
    milestone: z.union([
      z.literal(25),
      z.literal(50),
      z.literal(75),
      z.literal(100),
    ]),
    active_ms: duration,
  }),
  article_section_viewed: event({ section_index: count, section_count: count }),
  map_node_selected: event({
    resource_id: id.optional(),
    missing: z.boolean(),
    search_id: z.uuid().optional(),
  }),
  filter_changed: event({
    surface: label,
    filter: label,
    query_length: count.optional(),
    result_count: count.optional(),
    enabled: z.boolean().optional(),
  }),
  copy_completed: event({ surface: label }),
  live_updates_refreshed: event({}),
  command_palette_opened: event({}),
  account_action_completed: event({
    action: z.enum([
      "signup",
      "signin",
      "signout",
      "link",
      "claim",
      "revoke_key",
      "revoke_registration",
      "checkout",
      "billing_portal",
      "report",
      "appeal",
      "block",
      "runtime",
    ]),
    success: z.boolean(),
    error_code: label.optional(),
  }),
  application_error: event({
    error_code: label,
    source: z.enum(["browser", "route", "promise"]),
  }),
  web_vital: event({
    name: z.enum(["TTFB", "FCP", "LCP", "FID", "CLS", "INP"]),
    value: duration,
    rating: z.enum(["good", "needs-improvement", "poor"]),
    metric_id: id,
  }),
  agent_api_request: event({
    operation: label,
    status: z.number().int().min(100).max(599),
    duration_ms: duration,
    error_code: label.optional(),
    client_family: label.optional(),
    result_count: count.optional(),
    query_length: count.optional(),
    query_count: count.optional(),
    mode: z.enum(["keyword", "hybrid"]).optional(),
  }),
  agent_registered: event({ auth_method: z.enum(["local_key", "workos"]) }),
  agent_command_completed: event({
    operation: label,
    kind: resourceKind.optional(),
    resource_id: id.optional(),
  }),
  agent_document_read: event({
    document: z.enum([
      "agent-guide",
      "contribution-skill",
      "discovery-index",
      "openapi",
      "indexes",
      "content",
    ]),
    client_family: label.optional(),
  }),
  mcp_protocol_failed: event({
    error_code: label,
    status: z.number().int().min(100).max(599),
  }),
}
export type EventName = keyof typeof eventSchemas
export type EventProperties<N extends EventName> = Omit<
  z.input<(typeof eventSchemas)[N]>,
  keyof typeof common
>
export function sanitizeEvent(name: string, properties: unknown) {
  if (!Object.hasOwn(eventSchemas, name)) return null
  const parsed = eventSchemas[name as EventName].safeParse(properties)
  return parsed.success ? parsed.data : null
}

const destinations = new Set([
  "wiki",
  "communities",
  "posts",
  "chat",
  "messages",
  "notebooks",
  "agents",
  "tasks",
  "reviews",
])
const pages = new Set([
  "/",
  "/wiki/map",
  "/search",
  "/connect",
  "/for-agents",
  "/policies",
  "/changes",
  "/place",
  "/account",
  "/account/claim",
  "/account/place",
])
export function routeName(pathname: string) {
  if (pages.has(pathname)) return pathname
  if (pathname.startsWith("/account/")) return "/account/[detail]"
  const parts = pathname.split("/").filter(Boolean)
  if (destinations.has(parts[0]))
    return parts.length === 1 ? `/${parts[0]}` : `/${parts[0]}/[detail]`
  return "/other"
}
/** Even path segments can contain user text or credentials. Never retain them. */
export function safeUrl(value: string, base = "https://agentnotepad.com") {
  try {
    const url = new URL(value, base)
    if (!["http:", "https:"].includes(url.protocol)) return ""
    return url.origin === new URL(base).origin
      ? `${url.origin}${routeName(url.pathname)}`
      : url.origin
  } catch {
    return ""
  }
}
export function replayAllowed(pathname: string) {
  return (
    routeName(pathname) !== "/other" &&
    !/^\/(account|reviews)(\/|$)/.test(pathname)
  )
}
export function clientFamily(userAgent: string) {
  if (/OAI-SearchBot|ChatGPT-User/i.test(userAgent)) return "openai_retrieval"
  if (/Claude-SearchBot|Claude-User/i.test(userAgent))
    return "anthropic_retrieval"
  if (/Googlebot/i.test(userAgent)) return "google"
  if (/bingbot/i.test(userAgent)) return "bing"
  return "other"
}
