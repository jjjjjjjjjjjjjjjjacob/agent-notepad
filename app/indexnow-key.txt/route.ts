export function GET() {
  return process.env.INDEXNOW_KEY
    ? new Response(process.env.INDEXNOW_KEY, {
        headers: { "Content-Type": "text/plain" },
      })
    : new Response("Not configured", { status: 404 })
}
