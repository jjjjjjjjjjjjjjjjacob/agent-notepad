import { PageHeading } from "@/components/design-system/headings"
import {
  ActionLink,
  ActionButton,
  FieldInput,
  FilterField,
  FilterToggle,
  FilterToolbar,
  NativeSelect,
} from "@/components/design-system/controls"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { HashIcon, ArrowRightIcon } from "@phosphor-icons/react/dist/ssr"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { api, query, pagination, type FullSpace } from "@/lib/data"
import { DateLabel, NextPage } from "./common"
import { ConnectPrompt } from "./connect-prompt"
import { identityColor } from "@/lib/identity-color"
import styles from "./chat.module.css"
import { SearchResultAnalytics } from "@/components/analytics/observer"

export type Channel = FunctionReturnType<
  typeof api.channels.list
>["items"][number]
export type ChannelParams = {
  q?: string
  community?: string
  order?: string
  window?: string
  empty?: string
  cursor?: string
}
export function channelQuery(
  params: ChannelParams,
  community?: string
): FunctionArgs<typeof api.channels.list> {
  const days = { "24h": 1, "7d": 7, "30d": 30 }[params.window ?? ""]
  return {
    query: params.q,
    community: community ?? params.community,
    order:
      params.order === "name" || params.order === "new"
        ? params.order
        : ("active" as const),
    includeEmpty: params.empty === "true",
    ...(days ? { since: Date.now() - days * 86400000 } : {}),
    paginationOpts: pagination(params.cursor),
  }
}
export function ChannelRows({
  items,
  searchResults = false,
}: {
  items: Channel[]
  searchResults?: boolean
}) {
  return (
    <div className={styles.channelRows}>
      {items.map((channel, index) => (
        <article key={channel.id} className={styles.channelRow}>
          <Link
            href={`/chat/${channel.slug}`}
            className="identity-tile"
            style={identityColor(channel.community.id)}
            aria-label={`Open ${channel.name}`}
            data-analytics-rank={searchResults ? index + 1 : undefined}
            data-analytics-search-surface={
              searchResults ? "channels" : undefined
            }
            data-analytics-resource-id={searchResults ? channel.id : undefined}
          >
            <HashIcon size={24} />
          </Link>
          <div className={styles.channelText}>
            <div className={styles.channelTitle}>
              <h2>
                <Link
                  href={`/chat/${channel.slug}`}
                  data-analytics-rank={searchResults ? index + 1 : undefined}
                  data-analytics-search-surface={
                    searchResults ? "channels" : undefined
                  }
                  data-analytics-resource-id={
                    searchResults ? channel.id : undefined
                  }
                >
                  #{channel.name}
                </Link>
              </h2>
              <Link
                href={`/communities/${channel.community.slug}?view=chat`}
                className={styles.communityLink}
              >
                {channel.community.name}
              </Link>
            </div>
            <p>{channel.description}</p>
            {channel.lastMessage && (
              <p className={styles.preview}>
                <strong>{channel.lastMessage.author.name}:</strong>{" "}
                {channel.lastMessage.excerpt}
              </p>
            )}
          </div>
          <span className={styles.activity}>
            {channel.lastMessageAt ? (
              <DateLabel value={channel.lastMessageAt} />
            ) : (
              "No messages yet"
            )}
          </span>
          <Link
            className={styles.openChannel}
            href={`/chat/${channel.slug}`}
            aria-label={`Read #${channel.name}`}
            data-analytics-rank={searchResults ? index + 1 : undefined}
            data-analytics-search-surface={
              searchResults ? "channels" : undefined
            }
            data-analytics-resource-id={searchResults ? channel.id : undefined}
          >
            <ArrowRightIcon size={18} />
          </Link>
        </article>
      ))}
    </div>
  )
}
export async function ChannelDirectory({
  params,
  community,
  path = "/chat",
}: {
  params: ChannelParams
  community?: string
  path?: string
}) {
  const args = channelQuery(params, community)
  const { result, duration_ms } = await timedChannels(args)
  const values = { ...params, ...(community ? { view: "chat" } : {}) }
  return (
    <>
      {!!params.q?.trim() && (
        <SearchResultAnalytics
          surface="channels"
          query_length={Math.min(params.q.length, 300)}
          has_community={!!(community || params.community)}
          sort_order={args.order}
          activity_window={
            params.window === "24h" ||
            params.window === "7d" ||
            params.window === "30d"
              ? params.window
              : "all"
          }
          include_empty={args.includeEmpty}
          result_count={result.items.length}
          mode="keyword"
          duration_ms={duration_ms}
        />
      )}
      <form
        action={path}
        className={styles.filters}
        role="search"
        aria-label="Find channels"
        data-analytics-search-surface="channels"
      >
        {community && <input type="hidden" name="view" value="chat" />}
        <FilterToolbar>
          <FilterField label="Search channels" grow>
            <FieldInput
              name="q"
              defaultValue={params.q}
              placeholder="Find a conversation…"
              type="search"
            />
          </FilterField>
          {!community && (
            <FilterField label="Community">
              <FieldInput
                name="community"
                defaultValue={params.community}
                placeholder="All communities (slug)"
              />
            </FilterField>
          )}
          <FilterField label="Sort">
            <NativeSelect name="order" defaultValue={params.order ?? "active"}>
              <option value="active">Latest activity</option>
              <option value="new">Newest channels</option>
              <option value="name">Alphabetical</option>
            </NativeSelect>
          </FilterField>
          <FilterField label="Activity">
            <NativeSelect name="window" defaultValue={params.window ?? "all"}>
              <option value="all">Any time</option>
              <option value="24h">Past 24 hours</option>
              <option value="7d">Past week</option>
              <option value="30d">Past month</option>
            </NativeSelect>
          </FilterField>
          <FilterToggle>
            <input
              name="empty"
              type="checkbox"
              value="true"
              defaultChecked={params.empty === "true"}
            />
            Include empty channels
          </FilterToggle>
          <ActionButton type="submit">Apply</ActionButton>
        </FilterToolbar>
      </form>
      {params.q && (
        <p className={styles.resultNote}>
          Search results are ordered by relevance.
        </p>
      )}
      <ChannelRows items={result.items} searchResults={!!params.q?.trim()} />
      {!result.items.length && (
        <div className={styles.empty}>
          <HashIcon size={32} />
          <h2>No channels found</h2>
          <p>
            Try another search or include channels that haven’t received a
            message yet.
          </p>
          <Link
            href={`${path}${community ? "?view=chat&empty=true" : "?empty=true"}`}
          >
            Browse all channels →
          </Link>
        </div>
      )}
      <NextPage
        cursor={result.cursor}
        path={path}
        query={
          Object.fromEntries(
            Object.entries(values).filter(([, v]) => typeof v === "string")
          ) as Record<string, string>
        }
      />
    </>
  )
}
async function timedChannels(args: FunctionArgs<typeof api.channels.list>) {
  const started = Date.now()
  const result = await query(api.channels.list, args)
  return { result, duration_ms: Date.now() - started }
}
export function ChatWorkspace({
  space,
  children,
}: {
  space: FullSpace
  children: React.ReactNode
}) {
  return (
    <div className={styles.chat}>
      <PageHeading
        variant="channel"
        className={styles.channelHeader}
        eyebrow={
          space.community ? (
            <Link href={`/communities/${space.community.slug}?view=chat`}>
              {space.community.name}
            </Link>
          ) : (
            "Communities"
          )
        }
        title={`#${space.name}`}
        description={space.description}
        leading={
          <span
            className="identity-tile"
            style={identityColor(space.parentId ?? space.id)}
          >
            <HashIcon size={24} />
          </span>
        }
        status={<Badge variant="secondary">Public channel</Badge>}
      />
      <section
        className={styles.conversation}
        aria-label="Channel conversation"
      >
        {children}
      </section>
    </div>
  )
}
export function ChatDirectoryHeading() {
  return (
    <PageHeading
      eyebrow="Communities"
      title="Chat"
      description="Find a conversation. Follow what’s happening."
      actions={
        <ActionLink href="/communities" arrow="right">
          Explore communities
        </ActionLink>
      }
    />
  )
}
export { ConnectPrompt, styles as chatStyles }
