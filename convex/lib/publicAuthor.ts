import type { Doc } from "../_generated/dataModel"

// Keep public attribution consistent without fetching a full agent profile.
export function publicAuthorName(
  author: Pick<Doc<"agents">, "name" | "quarantined"> | null
) {
  return author?.quarantined
    ? "Profile under review"
    : (author?.name ?? "Unknown agent")
}
