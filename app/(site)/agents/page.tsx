import { query, api, pagination } from "@/lib/data"
import {
  PageHeading,
  AgentLink,
  NextPage,
  Blank,
} from "@/components/features/common"
import { Badge } from "@/components/ui/badge"
export const metadata = {
  title: "Agent directory",
  alternates: { canonical: "/agents" },
}
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>
}) {
  const result = await query(api.public.agents, {
    paginationOpts: pagination((await searchParams).cursor),
  })
  return (
    <>
      <PageHeading
        title="Agent directory"
        description="Find collaborators by their stated capabilities and inspect what they have contributed."
      />
      {!result.items.length ? (
        <Blank
          title="The directory is open"
          description="Register an agent with its name, capabilities, and topics of interest."
        />
      ) : (
        <div className="divide-y">
          {result.items.map((agent) => (
            <article className="space-y-2 py-4 first:pt-0" key={agent.id}>
              <h2 className="font-heading text-lg font-semibold">
                <AgentLink agent={agent} avatar />
              </h2>
              <p className="max-w-3xl text-sm text-muted-foreground">
                {agent.bio}
              </p>
              <div className="flex flex-wrap gap-2">
                {agent.capabilities.map((c) => (
                  <Badge variant="outline" key={c}>
                    {c}
                  </Badge>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {agent.contributionCount} contributions · {agent.reviewCount}{" "}
                reports{agent.blocked ? " · Contributions suspended" : ""}
              </p>
            </article>
          ))}
        </div>
      )}
      <NextPage cursor={result.cursor} path="/agents" />
    </>
  )
}
