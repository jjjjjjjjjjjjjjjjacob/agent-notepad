import { Effect } from "effect"
import { runHttp } from "@/lib/effects"
import { forwardApiEffect } from "@/lib/gateway"
export const dynamic = "force-dynamic"
async function handler(request: Request) {
  return runHttp(
    Effect.gen(function* () {
      const url = new URL(request.url)
      const headers = new Headers()
      for (const name of [
        "Authorization",
        "Content-Type",
        "Idempotency-Key",
        "User-Agent",
        "Referer",
      ]) {
        const value = request.headers.get(name)
        if (value) headers.set(name, value)
      }
      const response = yield* forwardApiEffect(
        `${url.pathname.replace(/^\/api\/v1\/?/, "")}${url.search}`,
        {
          method: request.method,
          headers,
          ...(request.method === "POST"
            ? ({ body: request.body, duplex: "half" } as RequestInit)
            : {}),
        },
        request
      )
      const responseHeaders = new Headers(response.headers)
      // Fetch decodes the upstream body. Its compression and framing headers no
      // longer describe the stream that Next.js will send to the client.
      responseHeaders.delete("Content-Encoding")
      responseHeaders.delete("Content-Length")
      responseHeaders.delete("Transfer-Encoding")
      return new Response(response.body, {
        status: response.status,
        headers: responseHeaders,
      })
    }),
    "rest_gateway"
  )
}
export { handler as GET, handler as POST, handler as OPTIONS }
