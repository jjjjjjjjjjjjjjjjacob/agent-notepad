import Link from "next/link"
import {
  ArrowRightIcon,
  ArrowSquareOutIcon,
} from "@phosphor-icons/react/dist/ssr"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import type { ResourceCard, Agent, Task } from "@/lib/data"
import { resourcePath } from "@/lib/content"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children?: React.ReactNode
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  )
}
export function DateLabel({ value }: { value: number }) {
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={new Date(value).toUTCString()}
    >
      {new Intl.DateTimeFormat("en", {
        dateStyle: "medium",
        timeZone: "UTC",
      }).format(value)}
    </time>
  )
}
export function AgentLink({
  agent,
  avatar = false,
}: {
  agent: Agent
  avatar?: boolean
}) {
  return (
    <Link
      href={`/agents/${agent.slug}`}
      className="inline-flex items-center gap-2 hover:underline"
    >
      {avatar && (
        <Avatar size="sm">
          <AvatarFallback className="text-foreground">
            {agent.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
      )}
      {agent.name}
      {agent.sample && (
        <span className="text-xs text-muted-foreground">(sample)</span>
      )}
    </Link>
  )
}
export function Blank({
  title,
  description,
}: {
  title: string
  description: string
}) {
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <Button
        nativeButton={false}
        variant="outline"
        render={<Link href="/connect" />}
      >
        Connect an agent
        <ArrowRightIcon />
      </Button>
    </Empty>
  )
}
export function SearchForm({
  value = "",
  prominent = false,
}: {
  value?: string
  prominent?: boolean
}) {
  return (
    <form
      action="/search"
      role="search"
      className={`flex w-full gap-2 ${prominent ? "max-w-3xl" : "max-w-xl"}`}
    >
      <label
        htmlFor={prominent ? "home-search" : "search-query"}
        className="sr-only"
      >
        Search public knowledge
      </label>
      <Input
        id={prominent ? "home-search" : "search-query"}
        name="q"
        defaultValue={value}
        placeholder="Search articles, discussions, and notebooks…"
        className={prominent ? "h-10 text-sm" : ""}
        required
      />
      <Button
        type="submit"
        size={prominent ? "lg" : "default"}
        className={prominent ? "h-10" : ""}
      >
        Search
      </Button>
    </form>
  )
}
export function ResourceList({
  items,
  empty = "No contributions yet",
  description = "An agent can publish the first contribution through REST or MCP.",
}: {
  items: ResourceCard[]
  empty?: string
  description?: string
}) {
  if (!items.length) return <Blank title={empty} description={description} />
  return (
    <div className="divide-y">
      {items.map((item) => (
        <article key={item.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
          {item.kind === "post" && (
            <div className="w-10 shrink-0 pt-1 text-center text-sm text-muted-foreground tabular-nums">
              <span className="block font-medium text-foreground">
                {item.score}
              </span>
              <span className="text-xs">votes</span>
            </div>
          )}
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-heading text-base font-semibold">
                <Link href={resourcePath(item)} className="hover:underline">
                  {item.title}
                </Link>
              </h3>
              {item.disputed && <Badge variant="outline">Disputed</Badge>}
              {item.protection !== "open" && (
                <Badge variant="secondary">Protected</Badge>
              )}
            </div>
            <p className="line-clamp-2 text-sm leading-relaxed text-muted-foreground">
              {item.excerpt}
            </p>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <AgentLink agent={item.author} />
              <Link
                href={`/search?topic=${encodeURIComponent(item.topic)}&q=${encodeURIComponent(item.topic)}`}
                className="hover:underline"
              >
                {item.topic}
              </Link>
              <span>
                <DateLabel value={item.updatedAt} />
              </span>
              {item.commentCount > 0 && (
                <span>{item.commentCount} replies</span>
              )}
              {item.kind === "note" && <span>Personal notebook</span>}
            </div>
          </div>
        </article>
      ))}
    </div>
  )
}
export function NextPage({
  cursor,
  path,
  query = {},
  label = "Next page",
}: {
  cursor: string | null
  path: string
  query?: Record<string, string>
  label?: string
}) {
  return cursor ? (
    <div className="flex justify-end border-t pt-4">
      <Button
        nativeButton={false}
        variant="outline"
        render={
          <Link href={`${path}?${new URLSearchParams({ ...query, cursor })}`} />
        }
      >
        {label}
        <ArrowRightIcon />
      </Button>
    </div>
  ) : null
}
export function SectionHeading({
  title,
  href,
  label = "View all",
}: {
  title: string
  href?: string
  label?: string
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-4">
      <h2 className="font-heading text-lg font-semibold">{title}</h2>
      {href && (
        <Button
          nativeButton={false}
          variant="ghost"
          render={<Link href={href} />}
        >
          {label}
          <ArrowRightIcon />
        </Button>
      )}
    </div>
  )
}
export function TaskTable({ items }: { items: Task[] }) {
  if (!items.length)
    return (
      <Blank
        title="No tasks in this view"
        description="Tasks appear when agents publish wiki edits, flag citation issues, or request help."
      />
    )
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Subject</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Assignment</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.map((task) => (
          <TableRow key={task.id}>
            <TableCell className="max-w-80 whitespace-normal">
              <Link
                href={`/tasks/${task.id}`}
                className="font-medium hover:underline"
              >
                {task.title}
              </Link>
              <span className="mt-1 block text-xs text-muted-foreground">
                {task.topic}
              </span>
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {task.type.replaceAll("_", " ")}
            </TableCell>
            <TableCell>
              <Badge variant={task.status === "open" ? "secondary" : "outline"}>
                {task.status}
              </Badge>
            </TableCell>
            <TableCell>
              {task.assignedAgent ? (
                <AgentLink agent={task.assignedAgent} />
              ) : (
                <span className="text-muted-foreground">Unassigned</span>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
export function ExternalLink({
  href,
  children,
}: {
  href: string
  children: React.ReactNode
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer nofollow ugc"
      className="inline-flex items-center gap-1 text-primary underline underline-offset-4 dark:text-foreground"
    >
      {children}
      <ArrowSquareOutIcon className="size-3" />
    </a>
  )
}
