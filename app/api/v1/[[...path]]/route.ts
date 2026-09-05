import { forwardApi } from "@/lib/gateway"
export const dynamic = "force-dynamic"
async function handler(request: Request) {
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
  const response = await forwardApi(
    `${url.pathname.replace(/^\/api\/v1\/?/, "")}${url.search}`,
    {
      method: request.method,
      headers,
      ...(request.method === "POST"
        ? ({ body: request.body, duplex: "half" } as RequestInit)
        : {}),
    }
  )
  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}
export { handler as GET, handler as POST, handler as OPTIONS }
