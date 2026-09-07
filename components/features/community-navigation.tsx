import Link from "next/link"
import { HashIcon, MagnifyingGlassIcon } from "@phosphor-icons/react/dist/ssr"
import { query, api, pagination } from "@/lib/data"
import type { Id } from "@/convex/_generated/dataModel"
import styles from "./shell.module.css"
import { SearchResultAnalytics } from "@/components/analytics/observer"

export async function CommunityNavigation({
  communitySlug,
  channelId,
  path,
  navq,
  navcursor,
  view,
}: {
  communitySlug: string
  channelId?: Id<"spaces">
  path: string
  navq?: string
  navcursor?: string
  view?: string
}) {
  const {
    result: [community, channels],
    duration_ms,
  } = await timedNavigation(
    Promise.all([
      query(api.public.getSpace, { slug: communitySlug }),
      query(api.channels.list, {
        community: communitySlug,
        query: navq,
        includeEmpty: true,
        order: "name",
        paginationOpts: pagination(navcursor, 20),
      }),
    ])
  )
  if (!community || community.kind !== "community") return null
  const more = new URLSearchParams({
    navcursor: channels.cursor ?? "",
    ...(navq ? { navq } : {}),
    ...(view ? { view } : {}),
  })
  return (
    <div className={styles.context}>
      {!!navq?.trim() && (
        <SearchResultAnalytics
          surface="channel_navigation"
          query_length={Math.min(navq.length, 300)}
          has_community
          include_empty
          sort_order="name"
          mode="keyword"
          result_count={channels.items.length}
          duration_ms={duration_ms}
        />
      )}
      <p className={styles.contextTitle}>{community.name}</p>
      <nav aria-label="Community navigation">
        <Link
          className={styles.navLink}
          href={`/communities/${community.slug}`}
          aria-current={
            path === `/communities/${community.slug}` && view !== "chat"
              ? "page"
              : undefined
          }
        >
          Posts
        </Link>
        <Link
          className={styles.navLink}
          href={`/communities/${community.slug}?view=chat`}
          aria-current={
            path === `/communities/${community.slug}` && view === "chat"
              ? "page"
              : undefined
          }
        >
          All community channels
        </Link>
      </nav>
      <form
        action={path}
        role="search"
        aria-label="Find community channels"
        data-analytics-search-surface="channel_navigation"
        className={styles.channelSearch}
      >
        {view && <input type="hidden" name="view" value={view} />}
        <input
          type="search"
          name="navq"
          defaultValue={navq}
          aria-label="Search this community’s channels"
          placeholder="Find a channel…"
        />
        <button type="submit" aria-label="Search channels">
          <MagnifyingGlassIcon size={14} />
        </button>
      </form>
      <nav aria-label="Community channels">
        {channels.items.map((channel, index) => (
          <Link
            className={styles.navLink}
            key={channel.id}
            href={`/chat/${channel.slug}`}
            data-analytics-search-surface="channel_navigation"
            data-analytics-rank={navq?.trim() ? index + 1 : undefined}
            data-analytics-resource-id={navq?.trim() ? channel.id : undefined}
            aria-current={channel.id === channelId ? "page" : undefined}
          >
            <HashIcon size={14} />
            <span>{channel.name}</span>
          </Link>
        ))}
      </nav>
      {!channels.items.length && <p>No matching channels.</p>}
      {channels.cursor && (
        <Link className={styles.contextMore} href={`${path}?${more}`}>
          More channels →
        </Link>
      )}
      <Link className={styles.contextMore} href="/chat">
        Discover public channels
      </Link>
    </div>
  )
}
async function timedNavigation<T>(request: Promise<T>) {
  const started = Date.now()
  return { result: await request, duration_ms: Date.now() - started }
}
