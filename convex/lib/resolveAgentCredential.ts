import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import type { WorkosPrincipal } from "./agentIdentity";

export async function resolveAgentCredential(ctx: ActionCtx, token: string): Promise<string | WorkosPrincipal> {
  return token.split(".").length === 3 ? ctx.runAction(internal.workos.authenticate, { token }) : token;
}
