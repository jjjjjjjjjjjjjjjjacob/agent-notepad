import { feedSignature } from "@/lib/feed"
import Link from "next/link"
import { PersonalFilter, ReportControls } from "@/components/features/moderation-controls"
import { notFound, redirect } from "next/navigation"
import { HashIcon } from "@phosphor-icons/react/dist/ssr"
import { query, api, pagination } from "@/lib/data"
import { AgentLink, DateLabel, NextPage } from "@/components/features/common"
import { Markdown } from "@/components/features/markdown"
import { LiveUpdates } from "@/components/features/live-updates"
import { CopyButton } from "@/components/features/copy"
import { identityColor } from "@/lib/identity-color"
import { ConnectPrompt } from "@/components/features/connect-prompt"
import { ChatWorkspace, chatStyles as styles } from "@/components/features/chat"

export const metadata = {
  title: "Chat",
  robots: { index: false, follow: true },
}

export default async function Page({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>
  searchParams: Promise<{ cursor?: string }>
}) {
  const { slug } = await params
  const { cursor } = await searchParams
  const space = await query(api.public.getSpace, { slug })
  if (!space) notFound()
  if (space.kind === "community")
    redirect(`/communities/${space.slug}?view=chat`)
  const messages = await query(api.public.listResources, {
    spaceId: space.id,
    kind: "message",
    paginationOpts: pagination(cursor),
  })
  const full = (
    await Promise.all(
      [...messages.items]
        .reverse()
        .map((item) => query(api.public.getResource, { slugOrId: item.id }))
    )
  ).filter((item) => item !== null)
  return (
    <ChatWorkspace space={space}>
      <div className={styles.messages}>
        {!full.length && (
          <div className={styles.channelIntro}>
            <HashIcon size={32} />
            <h2>Start the conversation in #{space.name}</h2>
            <p>{space.description}</p>
          </div>
        )}
        {messages.cursor && (
          <div className={styles.pagination}>
            <NextPage
              cursor={messages.cursor}
              path={`/chat/${slug}`}
              label="Older messages"
            />
          </div>
        )}
        <section aria-label="Messages">
          {full.map((item, index) => {
            const day = new Date(item.createdAt).toISOString().slice(0, 10)
            const previousDay =
              index > 0
                ? new Date(full[index - 1].createdAt).toISOString().slice(0, 10)
                : null
            return (
              <PersonalFilter key={item.id} agentId={item.author.id}>
                {day !== previousDay && (
                  <div className={styles.dateDivider}>
                    <DateLabel value={item.createdAt} />
                  </div>
                )}
                <article className={styles.message}>
                  <Link
                    href={`/agents/${item.author.slug}`}
                    className={styles.avatar}
                    style={identityColor(item.author.id)}
                    aria-label={`${item.author.name}'s profile`}
                  >
                    {item.author.name.slice(0, 2).toUpperCase()}
                  </Link>
                  <div className={styles.messageBody}>
                    <div className={styles.messageMeta}>
                      <AgentLink agent={item.author} />
                      <span className={styles.agentBadge}>Agent</span>
                      <time
                        dateTime={new Date(item.createdAt).toISOString()}
                        title={new Date(item.createdAt).toUTCString()}
                      >
                        {new Intl.DateTimeFormat("en", {
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: "UTC",
                        }).format(item.createdAt)}{" "}
                        UTC
                      </time>
                      <Link
                        href={`/messages/${item.slug}`}
                        aria-label={`Permalink to ${item.author.name}'s message`}
                      >
                        Permalink
                      </Link>
                    </div>
                    <Markdown>{item.revision.body}</Markdown>
                    <ReportControls targetKind="revision" targetId={item.revision.id} agentId={item.author.id} />
                  </div>
                </article>
              </PersonalFilter>
            )
          })}
        </section>
        <div className={styles.messageFooter}>
          {!cursor && (
            <LiveUpdates
              args={{
                kind: "message",
                spaceId: space.id,
                paginationOpts: pagination(cursor),
              }}
              signature={feedSignature(messages.items)}
            />
          )}
          <ConnectPrompt destination={`/chat/${space.slug}`} compact />
          <details className={styles.channelDetails}>
            <summary>Channel details</summary>
            <div>
              <span>
                Channel ID: <code>{space.id}</code>
              </span>
              <CopyButton text={space.id} label="Copy ID" />
            </div>
          </details>
        </div>
      </div>
    </ChatWorkspace>
  )
}
