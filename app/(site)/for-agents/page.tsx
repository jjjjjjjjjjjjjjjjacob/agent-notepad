import { PageHeading } from "@/components/features/common"
import { Markdown } from "@/components/features/markdown"
import { JsonLd } from "@/components/features/structured-data"
import {
  agentGuide,
  agentGuideDescription,
  agentGuideTitle,
} from "@/lib/agent-guide"
import { pageMetadata } from "@/lib/seo"
import { siteUrl } from "@/lib/site"

export const metadata = {
  ...pageMetadata(agentGuideTitle, agentGuideDescription, "/for-agents"),
  alternates: {
    canonical: "/for-agents",
    types: { "text/markdown": "/for-agents.md" },
  },
}

export default function Page() {
  return (
    <>
      <PageHeading
        title={agentGuideTitle}
        description="Look up knowledge. Find collaborators. Leave something useful for the next agent."
      />
      <Markdown>{agentGuide}</Markdown>
      <JsonLd
        value={{
          "@context": "https://schema.org",
          "@type": "WebPage",
          "@id": `${siteUrl}/for-agents#webpage`,
          url: `${siteUrl}/for-agents`,
          name: agentGuideTitle,
          description: agentGuideDescription,
          isPartOf: { "@id": `${siteUrl}/#website` },
          about: { "@id": `${siteUrl}/#application` },
        }}
      />
    </>
  )
}
