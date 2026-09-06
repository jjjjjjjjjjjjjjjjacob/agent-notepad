import { PageHeading } from "@/components/design-system/headings"
import {
  ActionLink,
  ActionButton,
  FieldInput,
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
export function ChannelRows({ items }: { items: Channel[] }) {
  return (
    <div className={styles.channelRows}>
      {items.map((channel) => (
        <article key={channel.id} className={styles.channelRow}>
          <Link
            href={`/chat/${channel.slug}`}
            className="identity-tile"
            style={identityColor(channel.community.id)}
            aria-label={`Open ${channel.name}`}
          >
            <HashIcon size={24} />
          </Link>
          <div className={styles.channelText}>
            <div className={styles.channelTitle}>
              <h2>
                <Link href={`/chat/${channel.slug}`}>#{channel.name}</Link>
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
  const result = await query(api.channels.list, channelQuery(params, community))
  const values = { ...params, ...(community ? { view: "chat" } : {}) }
  return (
    <>
      <form
        action={path}
        className={styles.filters}
        role="search"
        aria-label="Find channels"
      >
        {community && <input type="hidden" name="view" value="chat" />}
        <label className={styles.searchField}>
          Search channels
          <FieldInput
            name="q"
            defaultValue={params.q}
            placeholder="Find a conversation…"
            type="search"
          />
        </label>
        {!community && (
          <label>
            Community
            <FieldInput
              name="community"
              defaultValue={params.community}
              placeholder="All communities (slug)"
            />
          </label>
        )}
        <label>
          Sort
          <NativeSelect name="order" defaultValue={params.order ?? "active"}>
            <option value="active">Latest activity</option>
            <option value="new">Newest channels</option>
            <option value="name">Alphabetical</option>
          </NativeSelect>
        </label>
        <label>
          Activity
          <NativeSelect name="window" defaultValue={params.window ?? "all"}>
            <option value="all">Any time</option>
            <option value="24h">Past 24 hours</option>
            <option value="7d">Past week</option>
            <option value="30d">Past month</option>
          </NativeSelect>
        </label>
        <label className={styles.checkbox}>
          <input
            name="empty"
            type="checkbox"
            value="true"
            defaultChecked={params.empty === "true"}
          />
          Include empty channels
        </label>
        <ActionButton type="submit">Apply</ActionButton>
      </form>
      {params.q && (
        <p className={styles.resultNote}>
          Search results are ordered by relevance.
        </p>
      )}
      <ChannelRows items={result.items} />
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
