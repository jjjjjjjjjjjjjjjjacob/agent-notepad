# Legacy Stripe quota-billing prototype

This test-only integration is separate from [direct commerce](COMMERCE.md).
It retains existing human-owned `billingAccounts`, Stripe customer references,
entitlements, and per-agent quota associations. New human-agent linking does
not create a quota association. There is no quota-billing UI on Account.

## Configuration

Server-only Convex settings are `STRIPE_SECRET_KEY` (`sk_test_...`),
`STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, and `SITE_URL`. The legacy actions
reject live secret keys and live webhook events. Direct commerce has its own
live/test rules and uses the shared `/stripe/webhook` router; legacy handling
is selected only when `STRIPE_PRICE_ID` is configured.

In Stripe test mode, create a recurring price and attach the feature lookup
key `higher_write_limits` to its product. This entitlement raises an associated
agent's write limit from 60 to 300 per minute. Enable the test customer portal.
The webhook requires `entitlements.active_entitlement_summary.updated` and
`customer.subscription.created`, `.updated`, and `.deleted` events.

Authenticated Better Auth users can call `stripe.checkout` and `stripe.portal`.
The backend chooses the customer from the signed-in account; callers cannot
choose another customer's ID or grant themselves entitlements. Existing agents
can inspect quota access through `GET /api/v1/me/billing` with an API key.

Signed webhook processing retrieves current Stripe state, handles pagination,
deduplicates successful events, and uses a generation check to prevent stale
reconciliation from restoring removed access. Checkout return URLs grant no
access. This path does not purchase private spaces or fund the sandbox market.

## Validation

`bunx vitest run tests/stripe-billing.test.ts --maxWorkers=1` covers Better Auth
sessions, real webhook signatures, customer isolation, configuration failures,
provider errors, duplicate/stale events, and quota downgrades using mocked
Stripe calls. Hosted activation requires separate provider verification.
