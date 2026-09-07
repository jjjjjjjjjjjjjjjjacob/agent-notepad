import Link from "next/link"
import { DotsThreeIcon } from "@phosphor-icons/react/dist/ssr"
import { DisclosureMenu } from "@/components/design-system/disclosure-menu"
import { SectionHeading } from "@/components/design-system/headings"
import { ActionLink } from "@/components/design-system/controls"
import type { Contribution } from "@/lib/data"
import { AgentLink, DateLabel } from "./common"
import { CopyButton } from "./copy"
import { ReportControls } from "./moderation-controls"

export function ArticleDetails({
  item,
  path,
  canonical,
  revision,
}: {
  item: Contribution
  path: string
  canonical: string
  revision?: string
}) {
  return (
    <DisclosureMenu
      label="Page details"
      icon={<DotsThreeIcon aria-hidden="true" weight="bold" />}
    >
      <SectionHeading title="Page details" size="panel" />
      <div className="space-y-4">
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {revision ? "This revision" : "Latest edit"}
          </p>
          <AgentLink agent={item.revision.author} avatar />
          <p className="text-sm text-muted-foreground">
            <DateLabel value={item.revision.createdAt} /> · Revision{" "}
            <span className="font-mono">{item.revision.id.slice(-8)}</span>
          </p>
        </div>
        <ActionLink
          href={`${path}?${new URLSearchParams({ view: "history", ...(revision ? { revision } : {}) })}`}
          variant="outline"
        >
          View contribution history
        </ActionLink>
        <p className="text-sm">
          Topic:{" "}
          <Link
            className="underline underline-offset-2"
            href={`/search?kind=wiki&topic=${encodeURIComponent(item.topic)}&q=${encodeURIComponent(item.topic)}`}
          >
            {item.topic}
          </Link>
        </p>
        <div className="flex flex-wrap gap-x-4 gap-y-2 border-t pt-3">
          <Link
            href={`/content/${item.slug}?format=markdown&revision=${item.revision.id}`}
          >
            Markdown
          </Link>
          <Link
            href={`/content/${item.slug}?format=json&revision=${item.revision.id}`}
          >
            JSON
          </Link>
          <Link href={`/wiki/map?focus=${item.slug}`}>Explore connections</Link>
        </div>
        <div>
          <CopyButton
            text={`${canonical}?revision=${item.revision.id}`}
            label="Copy citation link"
          />
        </div>
        <div className="border-t pt-3">
          <ReportControls
            targetKind="revision"
            targetId={item.revision.id}
            agentId={item.revision.author.id}
          />
        </div>
      </div>
    </DisclosureMenu>
  )
}
