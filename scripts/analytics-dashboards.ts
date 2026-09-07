/** Reproducible PostHog dashboard definitions. Dry-run unless --apply is supplied. */
const production =
  "properties.environment = 'production' AND timestamp >= now() - INTERVAL 30 DAY"
const browser = `${production} AND properties.actor_type = 'human'`
const agents = `${production} AND properties.actor_type = 'agent'`
const sql = (name: string, query: string) => ({
  name,
  query: { kind: "DataTableNode", source: { kind: "HogQLQuery", query } },
})
const property = (key: string, value: string | boolean | string[]) => ({
  key,
  value: Array.isArray(value) ? value : [value],
  operator: "exact",
  type: "event",
})
const funnel = (
  name: string,
  actor: string,
  steps: {
    event: string
    action?: string
    operation?: string | string[]
    success?: boolean
  }[]
) => ({
  name,
  query: {
    kind: "InsightVizNode",
    source: {
      kind: "FunnelsQuery",
      dateRange: { date_from: "-30d" },
      properties: [
        property("environment", "production"),
        property("actor_type", actor),
      ],
      series: steps.map((step) => ({
        kind: "EventsNode",
        event: step.event,
        name: step.action ?? step.event,
        properties: [
          ...(step.action ? [property("action", step.action)] : []),
          ...(step.operation ? [property("operation", step.operation)] : []),
          ...(step.success !== undefined
            ? [property("success", step.success)]
            : []),
        ],
      })),
      funnelsFilter: {
        funnelWindowInterval: 30,
        funnelWindowIntervalUnit: "day",
      },
    },
  },
})
export const dashboards = [
  {
    name: "Traffic",
    description:
      "Consenting browser visitors only. Last 30 days. Query text and user-selected route segments are excluded.",
    insights: [
      sql(
        "Daily visitors, sessions, and views",
        `SELECT toDate(timestamp) AS day, uniq(person_id) AS visitors, uniq(properties.$session_id) AS sessions, count() AS views FROM events WHERE ${browser} AND event = '$pageview' GROUP BY day ORDER BY day`
      ),
      sql(
        "Popular routes",
        `SELECT properties.route AS route, uniq(person_id) AS visitors, count() AS views FROM events WHERE ${browser} AND event = '$pageview' GROUP BY route ORDER BY views DESC`
      ),
      sql(
        "Acquisition",
        `SELECT properties.referrer_domain AS referrer, properties.campaign_source AS source, properties.campaign_medium AS medium, properties.campaign_name AS campaign, uniq(person_id) AS visitors FROM events WHERE ${browser} AND event = '$pageview' GROUP BY referrer, source, medium, campaign ORDER BY visitors DESC`
      ),
      sql(
        "Returning visitors",
        `SELECT count() AS visitors, countIf(days_active > 1) AS returning_on_another_day FROM (SELECT person_id, uniq(toDate(timestamp)) AS days_active FROM events WHERE ${browser} AND event = '$pageview' GROUP BY person_id)`
      ),
    ],
  },
  {
    name: "Engagement",
    description:
      "Consenting browser reading, navigation, and feature adoption. Reading time excludes hidden tabs.",
    insights: [
      sql(
        "Reading depth and active time",
        `SELECT properties.route AS route, properties.milestone AS depth_percent, count() AS views_reaching_depth, avg(properties.active_ms) / 1000 AS average_active_seconds FROM events WHERE ${browser} AND event = 'reading_progress' GROUP BY route, depth_percent ORDER BY route, depth_percent`
      ),
      sql(
        "Navigation and sources",
        `SELECT properties.action AS action, properties.location AS location, properties.destination AS destination, count() AS clicks FROM events WHERE ${browser} AND event = 'navigation_clicked' GROUP BY action, location, destination ORDER BY clicks DESC`
      ),
      sql(
        "Feature adoption",
        `SELECT event, properties.route AS route, uniq(person_id) AS visitors, count() AS actions FROM events WHERE ${browser} AND event IN ('resource_viewed', 'map_node_selected', 'filter_changed', 'copy_completed', 'live_updates_refreshed', 'command_palette_opened') GROUP BY event, route ORDER BY visitors DESC`
      ),
    ],
  },
  {
    name: "Search",
    description:
      "Browser search effectiveness and separate agent retrieval measurements. No query text. Selection rate uses correlated search IDs.",
    insights: [
      sql(
        "Browser search outcomes",
        `SELECT properties.surface AS surface, properties.mode AS mode, count() AS searches, countIf(properties.result_count = 0) AS zero_results, 100.0 * countIf(properties.result_count = 0) / nullIf(count(), 0) AS zero_result_percent, avg(properties.duration_ms) AS average_ms, quantile(0.95)(properties.duration_ms) AS p95_ms FROM events WHERE ${browser} AND event = 'search_results_viewed' GROUP BY surface, mode`
      ),
      sql(
        "Search result selection rate",
        `SELECT count() AS searches, countIf(search_id IN (SELECT properties.search_id FROM events WHERE ${browser} AND event IN ('search_result_clicked', 'map_node_selected'))) AS searches_with_selection, 100.0 * searches_with_selection / nullIf(searches, 0) AS selection_percent FROM (SELECT DISTINCT properties.search_id AS search_id FROM events WHERE ${browser} AND event = 'search_results_viewed')`
      ),
      sql(
        "Selected result ranks",
        `SELECT properties.rank AS rank, count() AS selections FROM events WHERE ${browser} AND event = 'search_result_clicked' GROUP BY rank ORDER BY rank`
      ),
      sql(
        "API retrieval outcomes",
        `SELECT properties.actor_type AS actor, properties.transport AS transport, properties.operation AS operation, properties.mode AS mode, count() AS requests, countIf(properties.result_count = 0) AS zero_results, countIf(properties.status >= 400) AS failures, quantile(0.95)(properties.duration_ms) AS p95_ms FROM events WHERE ${production} AND properties.actor_type IN ('agent', 'anonymous_api') AND event = 'agent_api_request' AND properties.operation IN ('search', 'retrieve', 'channels') GROUP BY actor, transport, operation, mode`
      ),
    ],
  },
  {
    name: "Activation",
    description:
      "Human account/linking and verified agent activation are separate funnels. Browser visitors are never inferred to own independently registered agents.",
    insights: [
      funnel("Human sign-up to agent linking", "human", [
        { event: "account_action_completed", action: "signup", success: true },
        { event: "account_action_completed", action: "link", success: true },
      ]),
      funnel("Agent registration to first and repeat contribution", "agent", [
        { event: "agent_registered" },
        {
          event: "agent_command_completed",
          operation: [
            "publish",
            "edit",
            "revert",
            "comment",
            "create_space",
            "submit_work",
            "propose_correction",
          ],
        },
        {
          event: "agent_command_completed",
          operation: [
            "publish",
            "edit",
            "revert",
            "comment",
            "create_space",
            "submit_work",
            "propose_correction",
          ],
        },
      ]),
      sql(
        "Account action outcomes",
        `SELECT properties.action AS action, properties.success AS success, count() AS attempts FROM events WHERE ${browser} AND event = 'account_action_completed' GROUP BY action, success`
      ),
      sql(
        "Agent activity",
        `SELECT properties.operation AS operation, uniq(distinct_id) AS agents, count() AS completed_commands FROM events WHERE ${agents} AND event = 'agent_command_completed' GROUP BY operation ORDER BY completed_commands DESC`
      ),
    ],
  },
  {
    name: "Reliability",
    description:
      "Application/API failures and Web Vitals. Analytics delivery failure codes are authoritative in Convex/Vercel logs when PostHog is unreachable.",
    insights: [
      sql(
        "API latency and failures",
        `SELECT properties.transport AS transport, properties.operation AS operation, properties.status AS status, count() AS requests, quantile(0.95)(properties.duration_ms) AS p95_ms FROM events WHERE ${production} AND event = 'agent_api_request' GROUP BY transport, operation, status ORDER BY requests DESC`
      ),
      sql(
        "Browser and MCP failures",
        `SELECT event, properties.route AS route, properties.error_code AS error_code, count() AS failures FROM events WHERE ${production} AND event IN ('application_error', 'search_failed', 'mcp_protocol_failed') GROUP BY event, route, error_code ORDER BY failures DESC`
      ),
      sql(
        "Delivery retries",
        `SELECT event, properties.delivery_attempt AS attempt, count() AS delivered_events FROM events WHERE ${production} AND properties.delivery_attempt IS NOT NULL GROUP BY event, attempt ORDER BY attempt DESC, delivered_events DESC`
      ),
      sql(
        "Core Web Vitals",
        `SELECT properties.route AS route, properties.name AS metric, properties.rating AS rating, count() AS samples, quantile(0.75)(properties.value) AS p75 FROM events WHERE ${browser} AND event = 'web_vital' GROUP BY route, metric, rating`
      ),
    ],
  },
]

if (import.meta.main) {
  if (!process.argv.includes("--apply")) {
    console.log(JSON.stringify(dashboards, null, 2))
  } else {
    const key = process.env.POSTHOG_PERSONAL_API_KEY
    const project = process.env.POSTHOG_PROJECT_ID ?? ""
    if (!key || !/^\d+$/.test(project))
      throw new Error(
        "POSTHOG_PERSONAL_API_KEY and a numeric POSTHOG_PROJECT_ID are required. Keep the key server-only."
      )
    const root = `https://us.posthog.com/api/projects/${project}/`
    async function api(path: string, body?: unknown, method = "POST") {
      const response = await fetch(new URL(path, root), {
        method: body ? method : "GET",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      if (!response.ok)
        throw new Error(
          `PostHog request failed (${response.status}); no credentials or response body logged.`
        )
      return await response.json()
    }
    async function list(path: string) {
      const items: { id: number; name: string; description?: string }[] = []
      let next: string | null = path
      while (next) {
        const url = new URL(next, root)
        if (url.origin !== "https://us.posthog.com")
          throw new Error("Unexpected pagination host")
        const page = await api(url.href)
        items.push(...page.results)
        next = page.next
      }
      return items
    }
    const existing = await list("dashboards/?limit=100")
    const insights = await list("insights/?limit=100")
    for (const definition of dashboards) {
      const name = `Agent Notepad · ${definition.name}`
      const prior = existing.find((d) => d.name === name)
      const dashboard = await api(
        prior ? `dashboards/${prior.id}/` : "dashboards/",
        { name, description: definition.description, pinned: true },
        prior ? "PATCH" : "POST"
      )
      for (const insight of definition.insights) {
        const insightName = `${definition.name} · ${insight.name}`
        const priorInsight = insights.find((i) => i.name === insightName)
        await api(
          priorInsight ? `insights/${priorInsight.id}/` : "insights/",
          {
            ...insight,
            name: insightName,
            description: definition.description,
            dashboards: [dashboard.id],
            saved: true,
          },
          priorInsight ? "PATCH" : "POST"
        )
      }
      console.log(
        `https://us.posthog.com/project/${project}/dashboard/${dashboard.id}`
      )
    }
  }
}
