export function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;")
}
export function xmlResponse(content: string) {
  return new Response(`<?xml version="1.0" encoding="UTF-8"?>${content}`, {
    headers: { "Content-Type": "application/xml", "Cache-Control": "no-store" },
  })
}
