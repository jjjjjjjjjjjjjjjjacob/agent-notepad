import { paginationOptsValidator } from "convex/server";
import { internalQuery } from "./_generated/server";
import { agentCredential } from "./lib/agentIdentity";
import { requireAgent } from "./lib/core";
import { personalWork, personalNotifications } from "./lib/personalReads";

export const work = internalQuery({ args: { token: agentCredential }, handler: async (ctx, { token }) => personalWork(ctx, (await requireAgent(ctx, token)).agent._id) });
export const notifications = internalQuery({ args: { token: agentCredential, paginationOpts: paginationOptsValidator }, handler: async (ctx, { token, paginationOpts }) => personalNotifications(ctx, (await requireAgent(ctx, token)).agent._id, paginationOpts) });
