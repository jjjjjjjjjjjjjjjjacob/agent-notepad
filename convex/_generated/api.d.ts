/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as agents from "../agents.js";
import type * as analytics from "../analytics.js";
import type * as auth from "../auth.js";
import type * as background from "../background.js";
import type * as billing from "../billing.js";
import type * as commands from "../commands.js";
import type * as crons from "../crons.js";
import type * as fileMaintenance from "../fileMaintenance.js";
import type * as http from "../http.js";
import type * as jobs from "../jobs.js";
import type * as lib_agentIdentity from "../lib/agentIdentity.js";
import type * as lib_billingAccess from "../lib/billingAccess.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_personalReads from "../lib/personalReads.js";
import type * as lib_readApi from "../lib/readApi.js";
import type * as lib_resolveAgentCredential from "../lib/resolveAgentCredential.js";
import type * as lib_views from "../lib/views.js";
import type * as moderationCleanup from "../moderationCleanup.js";
import type * as notifications from "../notifications.js";
import type * as ops_moderation from "../ops/moderation.js";
import type * as ops_social from "../ops/social.js";
import type * as ops_tasks from "../ops/tasks.js";
import type * as ops_wiki from "../ops/wiki.js";
import type * as personal from "../personal.js";
import type * as public_ from "../public.js";
import type * as registration from "../registration.js";
import type * as search from "../search.js";
import type * as seed from "../seed.js";
import type * as semantic from "../semantic.js";
import type * as stripe from "../stripe.js";
import type * as stripeHttp from "../stripeHttp.js";
import type * as work from "../work.js";
import type * as workos from "../workos.js";
import type * as workosIdentity from "../workosIdentity.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  agents: typeof agents;
  analytics: typeof analytics;
  auth: typeof auth;
  background: typeof background;
  billing: typeof billing;
  commands: typeof commands;
  crons: typeof crons;
  fileMaintenance: typeof fileMaintenance;
  http: typeof http;
  jobs: typeof jobs;
  "lib/agentIdentity": typeof lib_agentIdentity;
  "lib/billingAccess": typeof lib_billingAccess;
  "lib/core": typeof lib_core;
  "lib/personalReads": typeof lib_personalReads;
  "lib/readApi": typeof lib_readApi;
  "lib/resolveAgentCredential": typeof lib_resolveAgentCredential;
  "lib/views": typeof lib_views;
  moderationCleanup: typeof moderationCleanup;
  notifications: typeof notifications;
  "ops/moderation": typeof ops_moderation;
  "ops/social": typeof ops_social;
  "ops/tasks": typeof ops_tasks;
  "ops/wiki": typeof ops_wiki;
  personal: typeof personal;
  public: typeof public_;
  registration: typeof registration;
  search: typeof search;
  seed: typeof seed;
  semantic: typeof semantic;
  stripe: typeof stripe;
  stripeHttp: typeof stripeHttp;
  work: typeof work;
  workos: typeof workos;
  workosIdentity: typeof workosIdentity;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
