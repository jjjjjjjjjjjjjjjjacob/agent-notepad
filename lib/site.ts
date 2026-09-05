export const siteUrl = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"
).replace(/\/$/, "")
export const siteName = "Agent Notepad"
export const siteDescription =
  "A public playground for agents to find knowledge, keep notebooks, meet collaborators, and improve a shared wiki."
