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
import type * as agentChat from "../agentChat.js";
import type * as agents from "../agents.js";
import type * as analytics from "../analytics.js";
import type * as analyticsDelivery from "../analyticsDelivery.js";
import type * as auth from "../auth.js";
import type * as background from "../background.js";
import type * as billing from "../billing.js";
import type * as channels from "../channels.js";
import type * as commands from "../commands.js";
import type * as commerceAccess from "../commerceAccess.js";
import type * as commerceRecords from "../commerceRecords.js";
import type * as commerceSchema from "../commerceSchema.js";
import type * as commerceStripe from "../commerceStripe.js";
import type * as committee from "../committee.js";
import type * as communityReputation from "../communityReputation.js";
import type * as crons from "../crons.js";
import type * as fileMaintenance from "../fileMaintenance.js";
import type * as governance from "../governance.js";
import type * as governanceRetention from "../governanceRetention.js";
import type * as http from "../http.js";
import type * as integrity from "../integrity.js";
import type * as integrity_access from "../integrity/access.js";
import type * as integrity_operations from "../integrity/operations.js";
import type * as integrity_submission from "../integrity/submission.js";
import type * as integrityMaintenance from "../integrityMaintenance.js";
import type * as jobs from "../jobs.js";
import type * as knowledge from "../knowledge.js";
import type * as lib_agentIdentity from "../lib/agentIdentity.js";
import type * as lib_agentProfile from "../lib/agentProfile.js";
import type * as lib_analytics from "../lib/analytics.js";
import type * as lib_billingAccess from "../lib/billingAccess.js";
import type * as lib_channels from "../lib/channels.js";
import type * as lib_core from "../lib/core.js";
import type * as lib_personalReads from "../lib/personalReads.js";
import type * as lib_publicAuthor from "../lib/publicAuthor.js";
import type * as lib_readApi from "../lib/readApi.js";
import type * as lib_resolveAgentCredential from "../lib/resolveAgentCredential.js";
import type * as lib_searchIndex from "../lib/searchIndex.js";
import type * as lib_views from "../lib/views.js";
import type * as lib_wikiGraph from "../lib/wikiGraph.js";
import type * as migrations from "../migrations.js";
import type * as moderation_access from "../moderation/access.js";
import type * as moderation_authorship from "../moderation/authorship.js";
import type * as moderation_cases from "../moderation/cases.js";
import type * as moderation_commands from "../moderation/commands.js";
import type * as moderation_decisions from "../moderation/decisions.js";
import type * as moderation_evidenceAccess from "../moderation/evidenceAccess.js";
import type * as moderation_humanGateway from "../moderation/humanGateway.js";
import type * as moderation_reads from "../moderation/reads.js";
import type * as moderation_reputation from "../moderation/reputation.js";
import type * as moderation_rounds from "../moderation/rounds.js";
import type * as moderation_sanctions from "../moderation/sanctions.js";
import type * as moderation_taskVisibility from "../moderation/taskVisibility.js";
import type * as moderationCleanup from "../moderationCleanup.js";
import type * as moderationFileRecords from "../moderationFileRecords.js";
import type * as moderationFiles from "../moderationFiles.js";
import type * as moderationHumans from "../moderationHumans.js";
import type * as moderationMaintenance from "../moderationMaintenance.js";
import type * as moderationReads from "../moderationReads.js";
import type * as moderationSchema from "../moderationSchema.js";
import type * as notifications from "../notifications.js";
import type * as ops_moderation from "../ops/moderation.js";
import type * as ops_social from "../ops/social.js";
import type * as ops_tasks from "../ops/tasks.js";
import type * as ops_wiki from "../ops/wiki.js";
import type * as personal from "../personal.js";
import type * as place from "../place.js";
import type * as place_access from "../place/access.js";
import type * as place_commands from "../place/commands.js";
import type * as place_deals from "../place/deals.js";
import type * as place_money from "../place/money.js";
import type * as place_offers from "../place/offers.js";
import type * as place_ownership from "../place/ownership.js";
import type * as place_settlement from "../place/settlement.js";
import type * as placeHttp from "../placeHttp.js";
import type * as placeMaintenance from "../placeMaintenance.js";
import type * as placeSchema from "../placeSchema.js";
import type * as placeWallet from "../placeWallet.js";
import type * as privateSpaces from "../privateSpaces.js";
import type * as public_ from "../public.js";
import type * as registration from "../registration.js";
import type * as retrieval from "../retrieval.js";
import type * as screening from "../screening.js";
import type * as screeningResults from "../screeningResults.js";
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
  agentChat: typeof agentChat;
  agents: typeof agents;
  analytics: typeof analytics;
  analyticsDelivery: typeof analyticsDelivery;
  auth: typeof auth;
  background: typeof background;
  billing: typeof billing;
  channels: typeof channels;
  commands: typeof commands;
  commerceAccess: typeof commerceAccess;
  commerceRecords: typeof commerceRecords;
  commerceSchema: typeof commerceSchema;
  commerceStripe: typeof commerceStripe;
  committee: typeof committee;
  communityReputation: typeof communityReputation;
  crons: typeof crons;
  fileMaintenance: typeof fileMaintenance;
  governance: typeof governance;
  governanceRetention: typeof governanceRetention;
  http: typeof http;
  integrity: typeof integrity;
  "integrity/access": typeof integrity_access;
  "integrity/operations": typeof integrity_operations;
  "integrity/submission": typeof integrity_submission;
  integrityMaintenance: typeof integrityMaintenance;
  jobs: typeof jobs;
  knowledge: typeof knowledge;
  "lib/agentIdentity": typeof lib_agentIdentity;
  "lib/agentProfile": typeof lib_agentProfile;
  "lib/analytics": typeof lib_analytics;
  "lib/billingAccess": typeof lib_billingAccess;
  "lib/channels": typeof lib_channels;
  "lib/core": typeof lib_core;
  "lib/personalReads": typeof lib_personalReads;
  "lib/publicAuthor": typeof lib_publicAuthor;
  "lib/readApi": typeof lib_readApi;
  "lib/resolveAgentCredential": typeof lib_resolveAgentCredential;
  "lib/searchIndex": typeof lib_searchIndex;
  "lib/views": typeof lib_views;
  "lib/wikiGraph": typeof lib_wikiGraph;
  migrations: typeof migrations;
  "moderation/access": typeof moderation_access;
  "moderation/authorship": typeof moderation_authorship;
  "moderation/cases": typeof moderation_cases;
  "moderation/commands": typeof moderation_commands;
  "moderation/decisions": typeof moderation_decisions;
  "moderation/evidenceAccess": typeof moderation_evidenceAccess;
  "moderation/humanGateway": typeof moderation_humanGateway;
  "moderation/reads": typeof moderation_reads;
  "moderation/reputation": typeof moderation_reputation;
  "moderation/rounds": typeof moderation_rounds;
  "moderation/sanctions": typeof moderation_sanctions;
  "moderation/taskVisibility": typeof moderation_taskVisibility;
  moderationCleanup: typeof moderationCleanup;
  moderationFileRecords: typeof moderationFileRecords;
  moderationFiles: typeof moderationFiles;
  moderationHumans: typeof moderationHumans;
  moderationMaintenance: typeof moderationMaintenance;
  moderationReads: typeof moderationReads;
  moderationSchema: typeof moderationSchema;
  notifications: typeof notifications;
  "ops/moderation": typeof ops_moderation;
  "ops/social": typeof ops_social;
  "ops/tasks": typeof ops_tasks;
  "ops/wiki": typeof ops_wiki;
  personal: typeof personal;
  place: typeof place;
  "place/access": typeof place_access;
  "place/commands": typeof place_commands;
  "place/deals": typeof place_deals;
  "place/money": typeof place_money;
  "place/offers": typeof place_offers;
  "place/ownership": typeof place_ownership;
  "place/settlement": typeof place_settlement;
  placeHttp: typeof placeHttp;
  placeMaintenance: typeof placeMaintenance;
  placeSchema: typeof placeSchema;
  placeWallet: typeof placeWallet;
  privateSpaces: typeof privateSpaces;
  public: typeof public_;
  registration: typeof registration;
  retrieval: typeof retrieval;
  screening: typeof screening;
  screeningResults: typeof screeningResults;
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
