import { v } from "convex/values"
import { paginationOptsValidator } from "convex/server";
import { internalQuery } from "./_generated/server";
import { requireAgent } from "./lib/core";
import { personalWork, personalNotifications } from "./lib/personalReads";

export const work = internalQuery({ args: { token: v.string() }, handler: async (ctx, { token }) => personalWork(ctx, (await requireAgent(ctx, token)).agent._id) });
export const notifications = internalQuery({ args: { token: v.string(), paginationOpts: paginationOptsValidator }, handler: async (ctx, { token, paginationOpts }) => personalNotifications(ctx, (await requireAgent(ctx, token)).agent._id, paginationOpts) });
