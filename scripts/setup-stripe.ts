import Stripe from "stripe"
import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { STRIPE_API_VERSION, STRIPE_EVENTS } from "../lib/stripe-config"

export async function setupStripe(args: string[]) {
  if (args.includes("--help")) {
    console.log(
      "Usage: bun run stripe:setup [--check] [--apply --deployment NAME] [--force-env]\nReads STRIPE_SECRET_KEY, SITE_URL, NEXT_PUBLIC_CONVEX_SITE_URL (or STRIPE_WEBHOOK_URL), optional STRIPE_AGENT_PROFILE_ID and STRIPE_WEBHOOK_SECRET. Creates/reuses a Stripe webhook and writes a private, ignored env file. --apply also sets those values on the explicitly named Convex deployment. --check performs read-only checks."
    )
    return
  }
  const deploymentIndex = args.indexOf("--deployment")
  const deployment =
    deploymentIndex >= 0 ? args[deploymentIndex + 1] : undefined
  const allowed = new Set([
    "--check",
    "--apply",
    "--deployment",
    "--force-env",
    ...(deployment ? [deployment] : []),
  ])
  if (
    args.some((arg) => !allowed.has(arg)) ||
    (deploymentIndex >= 0 && (!deployment || deployment.startsWith("--")))
  )
    throw new Error("Invalid arguments; use --help.")
  if (args.includes("--check") && args.includes("--apply"))
    throw new Error("Choose --check or --apply.")
  if (args.includes("--apply") && !deployment)
    throw new Error("--apply requires an explicit --deployment NAME.")
  const secret = process.env.STRIPE_SECRET_KEY ?? ""
  if (!/^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/.test(secret))
    throw new Error(
      "Set STRIPE_SECRET_KEY to a Stripe secret or restricted key."
    )
  const mode = /^(sk|rk)_live_/.test(secret) ? "live" : "test"
  const siteOrigin = process.env.SITE_URL || process.env.NEXT_PUBLIC_SITE_URL
  if (!siteOrigin)
    throw new Error(
      "Set SITE_URL (or NEXT_PUBLIC_SITE_URL) to your frontend origin."
    )
  const site = new URL(siteOrigin)
  if (
    site.protocol !== "https:" &&
    !(mode === "test" && ["localhost", "127.0.0.1"].includes(site.hostname))
  )
    throw new Error(
      "Use an HTTPS SITE_URL (localhost is allowed in test mode)."
    )
  if (
    site.username ||
    site.password ||
    site.search ||
    site.hash ||
    site.pathname !== "/"
  )
    throw new Error(
      "SITE_URL must be a plain origin without credentials, query, or path."
    )
  const webhookValue = process.env.STRIPE_WEBHOOK_URL
  const backendOrigin = process.env.NEXT_PUBLIC_CONVEX_SITE_URL
  if (!webhookValue && !backendOrigin)
    throw new Error(
      "Set NEXT_PUBLIC_CONVEX_SITE_URL or STRIPE_WEBHOOK_URL for the backend webhook."
    )
  const webhook = new URL(
    webhookValue || new URL("/stripe/webhook", backendOrigin).href
  )
  if (
    webhook.protocol !== "https:" ||
    webhook.username ||
    webhook.password ||
    webhook.search ||
    webhook.hash ||
    webhook.pathname !== "/stripe/webhook"
  )
    throw new Error(
      "Stripe webhook URL must be a public HTTPS URL ending in /stripe/webhook. Use Stripe CLI forwarding for a local backend."
    )
  const stripe = new Stripe(secret, {
    apiVersion: STRIPE_API_VERSION,
    timeout: 15_000,
    maxNetworkRetries: 2,
  })
  const endpoints: Stripe.WebhookEndpoint[] = []
  for await (const endpoint of stripe.webhookEndpoints.list({ limit: 100 })) {
    endpoints.push(endpoint)
    if (endpoints.length > 1000)
      throw new Error(
        "More than 1,000 webhooks; inspect the account before provisioning."
      )
  }
  const matches = endpoints.filter((e) => e.url === webhook.href)
  if (matches.length > 1)
    throw new Error(
      "Multiple Stripe endpoints use this webhook URL. Resolve the duplicates first."
    )
  let endpoint = matches[0]
  if (args.includes("--check")) {
    console.log(
      `Stripe ${mode} credentials accepted. ${endpoint ? "Webhook exists" : "Webhook will be created"}. Target: ${webhook.href}. ${deployment ? `Convex deployment: ${deployment}. ` : ""}No changes made.`
    )
    return
  }
  const hash = createHash("sha256")
    .update(`${mode}:${webhook.href}`)
    .digest("hex")
    .slice(0, 16)
  const directory = resolve(".artifacts/stripe")
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const recordPath = resolve(directory, `${hash}.json`)
  let saved: { endpointId?: string; webhookSecret?: string } = {}
  try {
    saved = JSON.parse(await readFile(recordPath, "utf8"))
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      throw new Error("Could not read the saved Stripe setup record.")
  }
  let webhookSecret =
    process.env.STRIPE_WEBHOOK_SECRET ||
    (saved.endpointId === endpoint?.id ? saved.webhookSecret : undefined)
  if (!endpoint) {
    endpoint = await stripe.webhookEndpoints.create(
      {
        url: webhook.href,
        api_version: STRIPE_API_VERSION,
        enabled_events: [...STRIPE_EVENTS],
        description: "Agent Notepad direct purchases",
        metadata: { agentNotepadCommerce: "v1" },
      },
      { idempotencyKey: `an-webhook:${hash}` }
    )
    webhookSecret = endpoint.secret
    if (!webhookSecret)
      throw new Error(
        "Stripe did not return a webhook secret. Retrieve it from the Stripe Dashboard and rerun with STRIPE_WEBHOOK_SECRET."
      )
    await writeFile(
      recordPath,
      JSON.stringify({ endpointId: endpoint.id, webhookSecret }),
      { mode: 0o600 }
    )
    await chmod(recordPath, 0o600)
  } else {
    if (!webhookSecret)
      throw new Error(
        "This webhook already exists. Set its STRIPE_WEBHOOK_SECRET from Stripe Dashboard and rerun; existing signing secrets cannot be read through the API."
      )
    // Preserve event types used by the older test billing integration.
    const enabled = endpoint.enabled_events.includes("*")
      ? ["*" as const]
      : ([
          ...new Set([...endpoint.enabled_events, ...STRIPE_EVENTS]),
        ] as Stripe.WebhookEndpointUpdateParams.EnabledEvent[])
    await stripe.webhookEndpoints.update(endpoint.id, {
      enabled_events: enabled,
      disabled: false,
    })
  }
  if (!/^whsec_[A-Za-z0-9_]+$/.test(webhookSecret))
    throw new Error("Invalid STRIPE_WEBHOOK_SECRET format.")
  const profile = process.env.STRIPE_AGENT_PROFILE_ID
  if (profile && !/^[A-Za-z0-9_]+$/.test(profile))
    throw new Error("Invalid STRIPE_AGENT_PROFILE_ID format.")
  const envFile = resolve(directory, `${hash}.env`)
  const values = {
    STRIPE_SECRET_KEY: secret,
    STRIPE_WEBHOOK_SECRET: webhookSecret,
    SITE_URL: site.origin,
    ...(profile ? { STRIPE_AGENT_PROFILE_ID: profile } : {}),
  }
  await writeFile(
    envFile,
    Object.entries(values)
      .map(([name, value]) => `${name}=${JSON.stringify(value)}`)
      .join("\n") + "\n",
    { mode: 0o600 }
  )
  await chmod(envFile, 0o600)
  if (args.includes("--apply")) {
    const processHandle = Bun.spawn(
      [
        "bunx",
        "convex",
        "env",
        "set",
        "--from-file",
        envFile,
        "--deployment",
        deployment!,
        ...(args.includes("--force-env") ? ["--force"] : []),
      ],
      { stdout: "pipe", stderr: "pipe" }
    )
    // CLI conflict diagnostics can contain existing env values; never echo them.
    await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ])
    if ((await processHandle.exited) !== 0)
      throw new Error(
        "Convex env update failed. Check deployment access and existing values. Use --force-env only to intentionally replace differing values. The private env file has been retained."
      )
    console.log(
      `Stripe ${mode} configured on Convex ${deployment}. Webhook: ${webhook.href}. No frontend Stripe secrets or price IDs are needed.`
    )
  } else
    console.log(
      `Stripe ${mode} webhook ready. Private env file: ${envFile}. Rerun with --apply --deployment NAME to configure Convex. Secrets were not printed.`
    )
  console.log(
    profile
      ? "Link shared-token merchant profile is configured; test provider eligibility before accepting live agent-wallet purchases."
      : "Hosted Link/card checkout is configured. To accept Link agent tokens, also set STRIPE_AGENT_PROFILE_ID to your Stripe business profile ID."
  )
}
if (import.meta.main)
  setupStripe(process.argv.slice(2)).catch((error) => {
    // Stripe diagnostics can include payment/account details. Keep these private.
    console.error(
      error instanceof Stripe.errors.StripeError
        ? `Stripe setup failed (${error.statusCode ?? "network"}). Check credentials, permissions, and Stripe availability.`
        : error instanceof Error
          ? error.message
          : "Stripe setup failed."
    )
    process.exitCode = 1
  })
