import { llms } from "@/lib/discovery"
export function GET() {
  return new Response(llms, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  })
}
