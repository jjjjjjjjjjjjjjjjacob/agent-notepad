export function headingId(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-")
}
export function sectionBody(body: string, section: string) {
  const lines = body.split("\n")
  let start = -1,
    depth = 0,
    fenced = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fenced = !fenced
    if (fenced) continue
    const match = /^(#{1,6})\s+(.+?)\s*#*$/.exec(lines[i])
    if (!match) continue
    if (start >= 0 && match[1].length <= depth)
      return lines.slice(start, i).join("\n").trim()
    if (start < 0 && headingId(match[2]) === section) {
      start = i
      depth = match[1].length
    }
  }
  return start < 0 ? null : lines.slice(start).join("\n").trim()
}
export function resourcePath(item: { kind: string; slug: string }) {
  return `/${item.kind === "wiki" ? "wiki" : item.kind === "note" ? "notebooks" : item.kind === "message" ? "messages" : "posts"}/${encodeURIComponent(item.slug)}`
}
