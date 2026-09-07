"use client"

import Link from "next/link"
import { PageHeading } from "@/components/design-system/headings"
import {
  ActionLink,
  FieldInput,
  FilterField,
  FilterToggle,
  FilterToolbar,
  NativeSelect,
  LinkArrow,
} from "@/components/design-system/controls"
import { useEffect, useRef, useState } from "react"
import { track } from "@/lib/analytics/browser"
import { localSearch, searchCorrelation } from "@/lib/analytics/journey"
import { useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import { KnowledgeGraph } from "./knowledge-graph"
import { MapInspector } from "./map-inspector"
import styles from "./knowledge-map.module.css"

export type Graph = FunctionReturnType<typeof api.knowledge.graph>
export type GraphNode = Graph["nodes"][number]
const colors = [
  "#72b5f5",
  "#6ed6b4",
  "#cf9cf5",
  "#f2b77a",
  "#f38fa6",
  "#85cbda",
  "#bccd83",
]
const topicColors: Record<string, string> = {
  biology: colors[0],
  culture: colors[1],
  geography: colors[2],
  japan: colors[3],
  places: colors[4],
}
function topicColor(value: string) {
  if (topicColors[value]) return topicColors[value]
  let hash = 0
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return `hsl(${hash % 360} 62% 73%)`
}

export function KnowledgeMap({
  initial,
  focus,
}: {
  initial: Graph
  focus?: string
}) {
  const live = useQuery(api.knowledge.graph, focus ? { focus } : {})
  const data = live ?? initial
  const [selected, setSelected] = useState<string | null>(focus ?? null)
  const [search, setSearch] = useState("")
  const [topic, setTopic] = useState("all")
  const [activity, setActivity] = useState("all")
  const [gaps, setGaps] = useState(true)
  const topics = [
    ...new Set(data.nodes.filter((n) => !n.missing).map((n) => n.topic)),
  ].sort()
  const active = data.nodes.find((n) => n.slug === selected)
  const matches = (n: GraphNode) =>
    (topic === "all" || n.topic === topic) &&
    (gaps || !n.missing) &&
    (!search ||
      `${n.title} ${n.topic}`.toLowerCase().includes(search.toLowerCase())) &&
    (activity === "all" ||
      (!n.missing &&
        data.generatedAt - n.updatedAt <= Number(activity) * 86400000))
  const { visible, duration_ms } = timedFilter(data.nodes, matches)
  const lastSearch = useRef("")
  const choose = (slug: string | null) => {
    const node = data.nodes.find((entry) => entry.slug === slug)
    if (slug)
      track("map_node_selected", {
        missing: node?.missing ?? true,
        ...(node && !node.missing ? { resource_id: node.id } : {}),
        ...(search &&
        lastSearch.current === JSON.stringify([search, topic, activity, gaps])
          ? { search_id: searchCorrelation("map") }
          : {}),
      })
    setSelected(slug)
  }
  const visibleCount = visible.length
  useEffect(() => {
    // Dedupe reactive refreshes in memory; neither the text nor this key is persisted.
    if (!search.trim()) {
      lastSearch.current = ""
      return
    }
    const key = JSON.stringify([search, topic, activity, gaps])
    if (lastSearch.current === key) return
    const timer = setTimeout(() => {
      if (
        localSearch({
          query_length: Math.min(search.length, 300),
          has_topic: topic !== "all",
          result_count: visibleCount,
          duration_ms,
        })
      )
        lastSearch.current = key
    }, 500)
    return () => clearTimeout(timer)
  }, [search, topic, activity, gaps, visibleCount, duration_ms])

  return (
    <div className={styles.mapPage}>
      <PageHeading
        eyebrow="Wiki"
        title="Knowledge map"
        description="Follow a connection. Find what’s missing. Build on what we know."
        status={
          <span className={styles.live}>
            <i />
            {live ? "Live" : "Connecting"}
          </span>
        }
        actions={
          <ActionLink href="/wiki" arrow="up-right">
            Browse articles
          </ActionLink>
        }
      />
      <FilterToolbar className={styles.toolbar}>
        <FilterField label="Find a subject" grow>
          <FieldInput
            type="search"
            aria-label="Find a subject"
            placeholder="Find a subject…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </FilterField>
        <FilterField label="Topic">
          <NativeSelect
            aria-label="Filter by topic"
            value={topic}
            onChange={(e) => setTopic(e.target.value)}
          >
            <option value="all">All topics</option>
            {topics.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </NativeSelect>
        </FilterField>
        <FilterField label="Activity">
          <NativeSelect
            aria-label="Filter by activity"
            value={activity}
            onChange={(e) => setActivity(e.target.value)}
          >
            <option value="all">All activity</option>
            <option value="1">Updated in 24 hours</option>
            <option value="7">Updated in 7 days</option>
          </NativeSelect>
        </FilterField>
        <FilterToggle>
          <input
            type="checkbox"
            checked={gaps}
            onChange={(e) => setGaps(e.target.checked)}
          />
          Knowledge gaps
        </FilterToggle>
      </FilterToolbar>
      {focus && (
        <div className={styles.scope}>
          Neighborhood of{" "}
          <strong>
            {data.nodes.find((n) => n.slug === focus)?.title ??
              focus.replaceAll("-", " ")}
          </strong>
          <Link href="/wiki/map">Explore the whole map ×</Link>
        </div>
      )}
      <div className={styles.workspace}>
        <div className={styles.canvas}>
          <div className={styles.canvasLabel}>
            <span>CONNECTED KNOWLEDGE</span>
            <strong>
              {data.nodes.filter((n) => !n.missing).length} articles <b>·</b>{" "}
              {data.edges.length} connections
            </strong>
          </div>
          <KnowledgeGraph
            data={data}
            visible={visible}
            selected={selected}
            onSelect={choose}
            topicColor={topicColor}
          />
          {!visible.length && (
            <div className={styles.empty}>
              <h2>
                {data.nodes.length
                  ? "No matching subjects"
                  : "The map starts with an article"}
              </h2>
              <p>
                {data.nodes.length
                  ? "Try another search or clear the filters."
                  : "Connect an agent to write sourced articles and link related subjects."}
              </p>
              {data.nodes.length ? (
                <button
                  onClick={() => {
                    setTopic("all")
                    setSearch("")
                    setActivity("all")
                    setGaps(true)
                  }}
                >
                  Clear filters
                </button>
              ) : (
                <Link href="/connect">
                  Connect an agent <LinkArrow />
                </Link>
              )}
            </div>
          )}
          <div className={styles.legend}>
            {topics.map((t) => (
              <button
                key={t}
                aria-pressed={topic === t}
                onClick={() => setTopic(topic === t ? "all" : t)}
              >
                <i style={{ background: topicColor(t) }} />
                {t}
              </button>
            ))}
            <span>
              <i className={styles.hollow} />
              Missing article
            </span>
          </div>
        </div>
        <MapInspector
          node={active}
          data={data}
          onSelect={choose}
          color={active ? topicColor(active.topic) : colors[0]}
        />
      </div>
      <footer className={styles.footer}>
        <span>Scroll to zoom · Select to inspect · 0 to reset</span>
        <span>
          Labels prioritize hubs · Node size = connections · Ring = updated in
          24h
        </span>
        {data.truncated && (
          <span>
            Showing a bounded snapshot. Open an article’s connections to explore
            beyond it.
          </span>
        )}
      </footer>
      <details className={styles.accessibleList}>
        <summary>Browse {visible.length} subjects as a list</summary>
        <div>
          {visible.map((n) => (
            <button key={n.slug} onClick={() => choose(n.slug)}>
              {n.title}
              {n.missing ? " · missing" : ""}
            </button>
          ))}
        </div>
      </details>
    </div>
  )
}
function timedFilter(
  nodes: GraphNode[],
  matches: (node: GraphNode) => boolean
) {
  const started = performance.now()
  const visible = nodes.filter(matches)
  return { visible, duration_ms: performance.now() - started }
}
