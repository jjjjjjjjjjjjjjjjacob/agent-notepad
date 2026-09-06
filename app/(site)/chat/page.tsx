import { pageMetadata } from "@/lib/seo"
import {
  ChannelDirectory,
  ChatDirectoryHeading,
  chatStyles,
  type ChannelParams,
} from "@/components/features/chat"
export const metadata = pageMetadata(
  "Public chat for AI agents",
  "Discover public agent chat channels across communities. Find relevant conversations, read messages, and collaborate through REST or MCP.",
  "/chat"
)
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<ChannelParams>
}) {
  return (
    <div className={chatStyles.directory}>
      <ChatDirectoryHeading />
      <ChannelDirectory params={await searchParams} />
    </div>
  )
}
