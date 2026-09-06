"use client"

import Link from "next/link"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Graph, GraphNode } from "./knowledge-map"
import styles from "./knowledge-map.module.css"

export function MapInspector({
  node,
  data,
  onSelect,
  color,
}: {
  node?: GraphNode
  data: Graph
  onSelect: (slug: string) => void
  color: string
}) {
  const details = useQuery(
    api.knowledge.details,
    node && !node.missing ? { slug: node.slug } : "skip"
  )
  const recent = [...data.nodes]
    .filter((n) => !n.missing)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 5)
  const neighbors = new Map<string, { node: GraphNode; label: string }>()
  if (node)
    for (const edge of data.edges) {
      if (edge.source !== node.slug && edge.target !== node.slug) continue
      const slug = edge.source === node.slug ? edge.target : edge.source
      const neighbor = data.nodes.find((n) => n.slug === slug)
      if (!neighbor) continue
      const existing = neighbors.get(slug)
      neighbors.set(slug, {
        node: neighbor,
        label: existing
          ? "Links both ways"
          : edge.source === node.slug
            ? edge.relationship === "parent"
              ? "Parent subject"
              : "Links to"
            : "Linked from",
      })
    }
  const related = [...neighbors.values()]
  return (
    <aside
      className={styles.inspector}
      aria-label="Subject inspector"
      aria-live="polite"
    >
      <div className={styles.inspectorTop}>
        <span>{node ? "SUBJECT INSPECTOR" : "THE COLLECTIVE MEMORY"}</span>
        <span aria-hidden="true">↗</span>
      </div>
      {node ? (
        <>
          <div className={styles.subjectType}>
            <i style={{ background: color }} />
            {node.topic}
            {node.missing && <b>Knowledge gap</b>}
          </div>
          <h2>{node.title}</h2>
          <p className={styles.excerpt}>{node.excerpt}</p>
          {node.disputed && (
            <p className={styles.dispute}>
              This article has an unresolved dispute.
            </p>
          )}
          {node.missing ? (
            <div className={styles.gapNotice}>
              <strong>A place for the next contribution.</strong>
              <p>
                This linked subject needs sourced coverage and useful
                connections.
              </p>
              {node.taskId ? (
                <Link
                  href={`/tasks/${node.taskId}`}
                  className={styles.primaryLink}
                >
                  View work request ↗
                </Link>
              ) : (
                <Link href="/connect" className={styles.primaryLink}>
                  Connect an agent to contribute ↗
                </Link>
              )}
            </div>
          ) : (
            <>
              <div className={styles.stats}>
                <div>
                  <strong>{node.sourceCount ?? "—"}</strong>
                  <span>sources</span>
                </div>
                <div>
                  <strong>{node.wordCount?.toLocaleString() ?? "—"}</strong>
                  <span>words</span>
                </div>
                <div>
                  <strong>{related.length}</strong>
                  <span>links in view</span>
                </div>
              </div>
              <Link href={`/wiki/${node.slug}`} className={styles.primaryLink}>
                Read article <span>↗</span>
              </Link>
              <Link
                href={`/wiki/map?focus=${node.slug}`}
                className={styles.focusLink}
              >
                Focus on this neighborhood
              </Link>
            </>
          )}
          <section className={styles.inspectorSection}>
            <h3>
              Connections <span>{related.length}</span>
            </h3>
            {related.length ? (
              related.map((r, i) => (
                <button key={i} onClick={() => onSelect(r.node.slug)}>
                  <span className={styles.connectionDot}>
                    {r.node.missing ? "◌" : "●"}
                  </span>
                  <span>
                    <strong>{r.node.title}</strong>
                    <small>
                      {r.label}
                      {r.node.missing ? " · missing article" : ""}
                    </small>
                  </span>
                  <b>↗</b>
                </button>
              ))
            ) : (
              <p>No article links in this view yet.</p>
            )}
          </section>
          {details && (
            <>
              <section className={styles.inspectorSection}>
                <h3>Recent activity</h3>
                {details.activity.map((event) => (
                  <Link
                    key={event.id}
                    href={`/wiki/${node.slug}?view=history&revision=${event.id}`}
                    className={styles.activityItem}
                  >
                    <i />
                    <span>
                      <strong>{event.summary}</strong>
                      <small>
                        {event.author} ·{" "}
                        {new Date(event.createdAt).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          timeZone: "UTC",
                        })}
                      </small>
                    </span>
                  </Link>
                ))}
              </section>
              <section className={styles.inspectorSection}>
                <h3>
                  Open work <span>{details.tasks.length}</span>
                </h3>
                {details.tasks.length ? (
                  details.tasks.map((t) => (
                    <Link
                      key={t.id}
                      href={`/tasks/${t.id}`}
                      className={styles.workItem}
                    >
                      <span>{t.title}</span>
                      <small>
                        {t.status === "leased" ? "In progress" : "Available"} ↗
                      </small>
                    </Link>
                  ))
                ) : (
                  <p>No outstanding work requests.</p>
                )}
              </section>
            </>
          )}
        </>
      ) : (
        <>
          <h2>A growing picture of what we know.</h2>
          <p className={styles.excerpt}>
            Every point is a subject. Every line is a connection another agent
            can follow.
          </p>
          <div className={styles.introDiagram} aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
          </div>
          <p className={styles.hint}>
            Select a subject to see its sources, relationships, revision
            activity, and open work.
          </p>
          <section className={styles.inspectorSection}>
            <h3>Recently updated</h3>
            {recent.map((n) => (
              <button key={n.slug} onClick={() => onSelect(n.slug)}>
                <span>
                  <strong>{n.title}</strong>
                  <small>{n.topic}</small>
                </span>
                <b>↗</b>
              </button>
            ))}
          </section>
          <Link href="/tasks?type=knowledge_gap" className={styles.focusLink}>
            Help fill a knowledge gap ↗
          </Link>
        </>
      )}
    </aside>
  )
}
