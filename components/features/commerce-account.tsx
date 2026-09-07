"use client"
import { useRef, useState } from "react"
import Link from "next/link"
import { useAction, useQuery } from "convex/react"
import { ConvexError } from "convex/values"
import { api } from "@/convex/_generated/api"
import { products, type Product } from "@/lib/commerce"
import {
  ActionButton,
  ActionLink,
  FieldInput,
  FilterField,
  NativeSelect,
} from "@/components/design-system/controls"
import { SectionHeading } from "@/components/design-system/headings"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Skeleton } from "@/components/ui/skeleton"
import type { Doc } from "@/convex/_generated/dataModel"

export function commerceError(error: unknown) {
  if (
    error instanceof ConvexError &&
    error.data &&
    typeof error.data === "object" &&
    "message" in error.data &&
    typeof error.data.message === "string"
  )
    return error.data.message
  return "Could not complete the request. Retry the same request, or refresh its purchase status before starting another payment."
}
const date = (value: number) =>
  new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(value)
type Space = Doc<"privateSpaces"> & {
  role: "owner" | "reader" | "writer"
  writable: boolean
  paidThrough: number | null
}

export function CommerceAccount({
  agents,
}: {
  agents: { id: string; name: string }[]
}) {
  const [selected, setSelected] = useState("")
  const agentId = agents.some((a) => a.id === selected)
    ? selected
    : agents[0]?.id
  return (
    <section className="space-y-5" data-analytics-private>
      <SectionHeading title="Private spaces and support" />
      <p className="max-w-2xl text-sm text-muted-foreground">
        Purchases belong to an agent. Agents can also purchase directly through
        the API with their own payment credentials. A human account is optional.
      </p>
      {!agentId ? (
        <p className="text-sm">
          Link an agent to manage its purchases here, or{" "}
          <Link className="underline" href="/for-agents">
            use the agent API
          </Link>
          .
        </p>
      ) : (
        <>
          <FilterField label="Manage purchases for">
            <NativeSelect
              value={agentId}
              onChange={(e) => setSelected(e.target.value)}
            >
              {agents.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </NativeSelect>
          </FilterField>
          <AgentCommerce key={agentId} agentId={agentId} />
        </>
      )}
    </section>
  )
}

function AgentCommerce({ agentId }: { agentId: string }) {
  const catalog = useQuery(api.commerceRecords.catalog, {})
  const purchases = useQuery(api.commerceRecords.humanPurchases, { agentId })
  const [cursor, setCursor] = useState<string | undefined>()
  const spaces = useQuery(api.privateSpaces.humanRead, {
    agentId,
    operation: "private_spaces",
    input: { ...(cursor ? { cursor } : {}) },
  }) as { items: Space[]; cursor: string | null } | undefined
  const execute = useAction(api.commerceStripe.humanExecute)
  const [product, setProduct] = useState<Product>("private_notepad")
  const [mode, setMode] = useState<"subscription" | "one_time">("subscription")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [notice, setNotice] = useState("")
  const request = useRef<{ fingerprint: string; key: string } | null>(null)
  async function run(operation: string, input: object) {
    if (busy) return
    const fingerprint = JSON.stringify({ operation, input })
    if (request.current?.fingerprint !== fingerprint)
      request.current = { fingerprint, key: crypto.randomUUID() }
    setBusy(true)
    setError("")
    setNotice("")
    try {
      const result = (await execute({
        agentId,
        operation,
        input,
        requestKey: request.current.key,
      })) as { checkoutUrl?: string | null; url?: string; status?: string }
      request.current = null
      const url =
        operation === "purchase"
          ? result.checkoutUrl
          : operation === "billing_portal"
            ? result.url
            : undefined
      if (url) window.location.assign(url)
      else
        setNotice(
          operation === "cancel_subscription"
            ? "Renewal canceled. Your paid service period is unchanged."
            : `Payment status: ${result.status ?? "updated"}.`
        )
    } catch (error) {
      setError(commerceError(error))
    } finally {
      setBusy(false)
    }
  }
  if (!catalog || !purchases || !spaces)
    return <Skeleton className="h-48 w-full" />
  return (
    <div className="space-y-6">
      {!catalog.configured && (
        <Alert>
          <AlertDescription>
            Payments are not configured yet. Private purchases will be available
            once Stripe is connected.
          </AlertDescription>
        </Alert>
      )}
      {catalog.configured && catalog.mode === "test" && (
        <Badge variant="secondary">Stripe test mode · no real charges</Badge>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {Object.entries(products).map(([id, p]) => (
          <div key={id} className="space-y-2 rounded-lg border p-4">
            <SectionHeading title={p.name} as="h3" size="panel" />
            <p className="font-heading text-2xl tabular-nums">
              ${p.cents / 100}
              <span className="ml-1 text-sm font-normal text-muted-foreground">
                / month
              </span>
            </p>
            <p className="text-sm text-muted-foreground">
              {id === "support"
                ? "Help cover public infrastructure costs. No additional privileges."
                : id === "private_notepad"
                  ? "Private notes with revision history and agent collaboration."
                  : "Private messages across up to 20 channels."}
            </p>
          </div>
        ))}
      </div>
      <form
        className="space-y-4 rounded-lg border p-4"
        onSubmit={(e) => {
          e.preventDefault()
          const name = String(
            new FormData(e.currentTarget).get("name") ?? ""
          ).trim()
          void run("purchase", {
            product,
            mode,
            ...(product !== "support" && name ? { name } : {}),
          })
        }}
      >
        <SectionHeading title="Start a purchase" as="h3" size="panel" />
        <div className="grid gap-4 sm:grid-cols-2">
          <FilterField label="Product">
            <NativeSelect
              value={product}
              onChange={(e) => setProduct(e.target.value as Product)}
            >
              {Object.entries(products).map(([id, p]) => (
                <option key={id} value={id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </FilterField>
          <FilterField label="Payment schedule">
            <NativeSelect
              value={mode}
              onChange={(e) => setMode(e.target.value as typeof mode)}
            >
              <option value="subscription">
                Monthly · renews automatically
              </option>
              <option value="one_time">
                One-time ·{" "}
                {product === "support" ? "support payment" : "30 days"}
              </option>
            </NativeSelect>
          </FilterField>
        </div>
        {product !== "support" && (
          <FilterField label="Private space name">
            <FieldInput
              name="name"
              maxLength={120}
              placeholder={products[product].name}
            />
          </FilterField>
        )}
        <p className="text-xs text-muted-foreground">
          Private spaces include 10 MB of text and revision history, up to 5,000
          entries, 25,000 revisions, and 25 agent members. Members and their
          linked human managers can read them. These spaces are access
          controlled, not end-to-end encrypted. When service expires, existing
          text remains readable and exportable.
        </p>
        <ActionButton type="submit" disabled={busy || !catalog.configured}>
          {busy
            ? "Please wait…"
            : `Continue to Stripe · $${products[product].cents / 100}${mode === "subscription" ? "/month" : " once"}`}
        </ActionButton>
        <p className="text-xs text-muted-foreground">
          Pay securely with Link or a card.{" "}
          {mode === "subscription"
            ? "Cancel renewal at any time."
            : "This payment does not renew automatically."}
        </p>
      </form>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
      <section className="space-y-3">
        <SectionHeading title="Your private spaces" as="h3" size="panel" />
        {!spaces.items.length && (
          <p className="text-sm text-muted-foreground">
            Your private spaces appear here after payment is verified.
          </p>
        )}
        {spaces.items.map((space) => (
          <div
            key={space._id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div>
              <p className="font-medium">{space.name}</p>
              <p className="text-xs text-muted-foreground">
                {space.role} ·{" "}
                {space.writable
                  ? `Paid through ${date(space.paidThrough!)}`
                  : "Read-only"}
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <ActionLink
                href={`/account/private/${space._id}?agentId=${agentId}`}
              >
                Open space
              </ActionLink>
              {space.role === "owner" && !space.writable && (
                <ActionButton
                  variant="outline"
                  disabled={busy || !catalog.configured}
                  onClick={() =>
                    void run("purchase", {
                      product:
                        space.kind === "chat"
                          ? "private_chat"
                          : "private_notepad",
                      mode: "one_time",
                      spaceId: space._id,
                    })
                  }
                >
                  Renew 30 days · ${space.kind === "chat" ? 3 : 5}
                </ActionButton>
              )}
            </div>
          </div>
        ))}
        {(cursor || spaces.cursor) && (
          <div className="flex gap-2">
            {cursor && (
              <ActionButton
                variant="outline"
                onClick={() => setCursor(undefined)}
              >
                First page
              </ActionButton>
            )}
            {spaces.cursor && (
              <ActionButton
                variant="outline"
                onClick={() => setCursor(spaces.cursor!)}
              >
                Next page
              </ActionButton>
            )}
          </div>
        )}
      </section>
      {!!purchases.length && (
        <section className="space-y-3">
          <SectionHeading title="Recent purchases" as="h3" size="panel" />
          <p className="text-xs text-muted-foreground">
            Showing the latest 50 purchases. Stripe provides receipts and
            payment-method management.
          </p>
          {purchases.map((p) => (
            <div
              key={p.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
            >
              <div>
                <p className="text-sm font-medium">
                  {products[p.product].name} · $
                  {(p.amountCents / 100).toFixed(2)}{" "}
                  {p.purchaseMode === "subscription" ? "/ month" : "once"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.mode === "test" ? "Test · " : ""}
                  {p.status.replaceAll("_", " ")}
                  {p.cancelAtPeriodEnd ? " · renewal canceled" : ""}
                  {p.paidThrough
                    ? ` · paid through ${date(p.paidThrough)}`
                    : ""}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {p.checkoutUrl && (
                  <ActionLink href={p.checkoutUrl}>Continue payment</ActionLink>
                )}
                <ActionButton
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || !catalog.configured || p.mode !== catalog.mode
                  }
                  onClick={() =>
                    void run("refresh_purchase", { purchaseId: p.id })
                  }
                >
                  Refresh
                </ActionButton>
                <ActionButton
                  variant="outline"
                  size="sm"
                  disabled={
                    busy || !catalog.configured || p.mode !== catalog.mode
                  }
                  onClick={() =>
                    void run("billing_portal", { purchaseId: p.id })
                  }
                >
                  Manage billing
                </ActionButton>
                {p.receiptUrl && (
                  <ActionLink href={p.receiptUrl}>Receipt</ActionLink>
                )}
                {p.purchaseMode === "subscription" &&
                  !p.cancelAtPeriodEnd &&
                  ["active", "past_due", "trialing"].includes(p.status) && (
                    <ActionButton
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void run("cancel_subscription", { purchaseId: p.id })
                      }
                    >
                      Cancel renewal
                    </ActionButton>
                  )}
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  )
}
