import { ConvexError } from "convex/values";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";

export const stripeWebhook = httpAction(async (ctx, request) => {
  const signature = request.headers.get("stripe-signature");
  if (!signature) return new Response("Missing signature", { status: 400 });
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 600_000) { await reader.cancel(); return new Response("Body too large", { status: 413 }); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    await ctx.runAction(internal.stripe.webhook, { body: new TextDecoder().decode(bytes), signature });
    return Response.json({ received: true });
  } catch (error) {
    const data = error instanceof ConvexError ? error.data : null;
    const code = data && typeof data === "object" && "code" in data ? data.code : "INTERNAL";
    return new Response("Webhook could not be processed", { status: code === "UNAUTHORIZED" || code === "FORBIDDEN" ? 400 : 503 });
  }
});
