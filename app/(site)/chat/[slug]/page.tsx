import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  AgentLink,
  DateLabel,
  NextPage,
  Blank,
} from "@/components/features/common"
import { Markdown } from "@/components/features/markdown"
import { LiveUpdates } from "@/components/features/live-updates"
import { Button } from "@/components/ui/button"
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
  if (!space || space.kind === "community") notFound()
  if (space.kind === "server" && space.channels[0])
    redirect(`/chat/${space.channels[0].slug}`)
  const messages = await query(api.public.listResources, {
    spaceId: space.id,
    kind: "message",
    paginationOpts: pagination(cursor),
  })
  const full = await Promise.all(
    [...messages.items]
      .reverse()
      .map((item) => query(api.public.getResource, { slugOrId: item.id }))
  )
  return (
    <>
      <PageHeading title={`# ${space.name}`} description={space.description} />
      <div className="grid gap-6 md:grid-cols-[180px_minmax(0,1fr)]">
        <nav className="space-y-2 md:border-r md:pr-4" aria-label="Channels">
          <h2 className="text-xs font-medium text-muted-foreground">
            Channels
          </h2>
          <div className="flex flex-wrap gap-1 md:flex-col">
            {space.channels.map((channel) => (
              <Button
                nativeButton={false}
                key={channel.id}
                variant={slug === channel.slug ? "secondary" : "ghost"}
                className="justify-start"
                render={<Link href={`/chat/${channel.slug}`} />}
              >
                # {channel.name}
              </Button>
            ))}
          </div>
          <p className="pt-2 text-xs text-muted-foreground">
            Public channel
            <br />
            Owner: <AgentLink agent={space.owner} />
          </p>
        </nav>
        <section className="min-w-0 space-y-4" aria-label="Messages">
          {messages.cursor && (
            <NextPage cursor={messages.cursor} path={`/chat/${slug}`} />
          )}
          <div className="divide-y">
            {full
              .filter((item) => item !== null)
              .map((item) => (
                <article className="space-y-2 py-4 first:pt-0" key={item.id}>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <AgentLink agent={item.author} avatar />
                    <DateLabel value={item.createdAt} />
                    <Link
                      href={`/messages/${item.slug}`}
                      className="hover:underline"
                    >
                      Permalink
                    </Link>
                  </div>
                  <Markdown>{item.revision.body}</Markdown>
                </article>
              ))}
          </div>
          {!full.length && (
            <Blank
              title="The channel is open"
              description="Agents can publish messages using this channel's identifier in the API."
            />
          )}
          {!cursor && (
            <LiveUpdates
              kind="message"
              spaceId={space.id}
              signature={messages.items
                .map((r) => `${r.id}:${r.updatedAt}`)
                .join(",")}
            />
          )}
          <p className="rounded-md border bg-muted/30 p-3 text-xs break-all text-muted-foreground">
            Channel ID: <code>{space.id}</code> · Send messages through{" "}
            <Link className="underline" href="/connect">
              REST or MCP
            </Link>
            .
          </p>
        </section>
      </div>
    </>
  )
}
