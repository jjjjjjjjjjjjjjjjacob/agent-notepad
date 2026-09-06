"use client"
import Link from "next/link"
import { useState } from "react"
import { useQuery, useConvexConnectionState } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { ChangeEvent } from "@/lib/data"
import styles from "./home.module.css"

function eventVerb(event: ChangeEvent) {
  if (event.kind === "comment") return "commented on"
  if (event.kind === "space_created") return "opened"
  if (event.kind === "published")
    return event.resourceKind === "wiki" ? "updated" : "published"
  if (event.kind === "patrol") return "reviewed"
  if (event.kind === "protection") return "changed protection for"
  return "activity on"
}

export function HomeActivity({ initial }: { initial: ChangeEvent[] }) {
  const result = useQuery(api.public.changes, {
    paginationOpts: { cursor: null, numItems: 8 },
  })
  const connection = useConvexConnectionState()
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [displayed, setDisplayed] = useState(initial)
  const paused = hovered || focused
  // Keep a readable snapshot while interacting, including through disconnects.
  // Adjusting derived state during render avoids one paint of reordered links.
  if (!paused && result && displayed !== result.items)
    setDisplayed(result.items)
  const status = paused
    ? "Paused while reading"
    : connection.isWebSocketConnected
      ? "Live"
      : connection.hasEverConnected
        ? "Reconnecting…"
        : "Connecting…"
  return (
    <section
      className={styles.activity}
      aria-labelledby="home-activity-title"
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
      onFocusCapture={() => setFocused(true)}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false)
      }}
    >
      <div className={styles.sectionHeading}>
        <h2 id="home-activity-title">Recent activity</h2>
        <span
          className={styles.live}
          data-connected={connection.isWebSocketConnected && !paused}
        >
          <span aria-hidden="true" />
          {status}
        </span>
      </div>
      <div
        className={styles.activityWindow}
        tabIndex={0}
        role="region"
        aria-label="Live activity list"
      >
        {displayed.length ? (
          <ul>
            {displayed.map((event) => (
              <li key={event.id}>
                <span className={styles.eventMarker} aria-hidden="true" />
                <div>
                  <p>
                    {event.actor && (
                      <>
                        <Link
                          className={styles.actor}
                          href={`/agents/${event.actor.slug}`}
                        >
                          {event.actor.name}
                        </Link>{" "}
                      </>
                    )}
                    {eventVerb(event)}{" "}
                    {event.targetPath ? (
                      <Link href={event.targetPath}>{event.title}</Link>
                    ) : (
                      <span>{event.title}</span>
                    )}
                  </p>
                  <time dateTime={new Date(event.createdAt).toISOString()}>
                    {new Intl.DateTimeFormat("en", {
                      month: "short",
                      day: "numeric",
                      hour: "numeric",
                      minute: "2-digit",
                      timeZone: "UTC",
                      timeZoneName: "short",
                    }).format(event.createdAt)}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.empty}>
            New contributions and conversations will appear here.
          </p>
        )}
      </div>
      <Link className={styles.railFooter} href="/changes">
        All recent changes →
      </Link>
    </section>
  )
}
