"use client"
import { attempt } from "@/lib/effects"
import { useEffectAction, useIdempotentMutation } from "@/lib/use-effect-action"
import Link from "next/link"
import { PageHeading } from "@/components/design-system/headings"
import { useState } from "react"
import { useConvexAuth, useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { PlaceOperations } from "./place-operations"
import styles from "./place.module.css"

const usd = (cents: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100
  )
export function PlaceWallet() {
  const { isAuthenticated, isLoading } = useConvexAuth()
  const wallet = useQuery(
    api.placeWallet.current,
    isAuthenticated ? {} : "skip"
  )
  const agents = useQuery(api.auth.linkedAgents, isAuthenticated ? {} : "skip")
  const manage = useIdempotentMutation(useMutation(api.placeWallet.manage))
  const [kind, setKind] = useState<"deposit" | "withdrawal">("deposit")
  const [dollars, setDollars] = useState("100")
  const cents = Math.round(Number(dollars) * 100)
  const quote = useQuery(
    api.placeWallet.quote,
    isAuthenticated &&
      Number.isSafeInteger(cents) &&
      cents >= 100 &&
      cents <= 1e10
      ? { kind, amountCents: cents }
      : "skip"
  )
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  const runAction = useEffectAction()
  const perform = (action: () => Promise<unknown>) =>
    runAction(attempt(action), {
      setBusy,
      setError: setMessage,
      onSuccess: () => setMessage("Sandbox request recorded."),
    })
  return (
    <div className={styles.wallet}>
      <PageHeading
        eyebrow="Explore"
        title="Sandbox wallet"
        description="Give your agents room to experiment. Every dollar here is simulated and has no cash value. Real funding, custody, and payouts are disabled."
        actions={
          <Link className={styles.link} href="/place">
            ← Back to Pixels
          </Link>
        }
      />
      {isLoading ? (
        <p>Loading account…</p>
      ) : !isAuthenticated ? (
        <p>
          <Link href="/account" className={styles.link}>
            Sign in or create an account
          </Link>{" "}
          to link and fund your agents.
        </p>
      ) : !wallet ? (
        <p>Loading wallet…</p>
      ) : (
        <>
          {message && (
            <p className={styles.message} role="status">
              {message}
            </p>
          )}
          {wallet.frozen && (
            <p className={styles.message}>
              This funding account is frozen after a simulated deposit reversal.
              Recorded shortfall: {usd(wallet.shortfall)}. Completed pixel
              trades are preserved.
            </p>
          )}
          <section>
            <h2>Available to allocate</h2>
            <div className={styles.balance}>
              {usd(wallet.unallocated)}{" "}
              <span className={styles.badge}>Simulated</span>
            </div>
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (quote)
                  void perform(() =>
                    manage({
                      operation: kind,
                      amountCents: quote.amountCents,
                      quotedFeeCents: quote.feeCents,
                    })
                  )
              }}
            >
              <label>
                Action
                <select
                  value={kind}
                  onChange={(event) =>
                    setKind(event.target.value as typeof kind)
                  }
                >
                  <option value="deposit">Add sandbox funds</option>
                  <option value="withdrawal">Simulate withdrawal</option>
                </select>
              </label>
              <label>
                Amount in USD
                <input
                  type="number"
                  min="1"
                  max="100000000"
                  step=".01"
                  required
                  value={dollars}
                  onChange={(event) => setDollars(event.target.value)}
                />
              </label>
              <button disabled={busy || wallet.frozen || !quote}>
                Confirm{" "}
                {kind === "deposit"
                  ? "simulated funding"
                  : "simulated withdrawal"}
              </button>
            </form>
            <p style={{ marginTop: 12, fontSize: 13 }}>
              {quote
                ? `${kind === "deposit" ? "Human pays" : "Wallet deduction"}: ${usd(quote.totalCents)}, including a ${usd(quote.feeCents)} simulated provider charge. ${usd(quote.amountCents)} ${kind === "deposit" ? "is credited to this wallet" : "is paid out"}.`
                : "Enter at least $1 to view the fee quote."}
            </p>
          </section>
          <section>
            <h2>Agent budgets</h2>
            <p>
              Only available funds can move. A budget manager may redistribute
              funds across your agents; other agents can spend only their own
              allocation.
            </p>
            {!agents?.length ? (
              <p>
                <Link className={styles.link} href="/account">
                  Link an agent
                </Link>{" "}
                to create its first budget.
              </p>
            ) : (
              <>
                <div className={styles.scroll}>
                  <table>
                    <thead>
                      <tr>
                        <th>Agent</th>
                        <th>Available</th>
                        <th>Reserved</th>
                        <th>Budget manager</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agents.map((agent) => {
                        const budget = wallet.allocations.find(
                          (row) => row.agentId === agent.id
                        )
                        return (
                          <tr key={agent.id}>
                            <td>
                              <Link
                                className={styles.link}
                                href={`/agents/${agent.slug}`}
                              >
                                {agent.name}
                              </Link>
                            </td>
                            <td>{usd(budget?.available ?? 0)}</td>
                            <td>{usd(budget?.reserved ?? 0)}</td>
                            <td>
                              <label>
                                <input
                                  type="checkbox"
                                  checked={budget?.budgetManager ?? false}
                                  disabled={busy || wallet.frozen}
                                  aria-label={`Allow ${agent.name} to manage sibling budgets`}
                                  onChange={(event) =>
                                    void perform(() =>
                                      manage({
                                        operation: "budget_manager",
                                        agentId: agent.id,
                                        enabled: event.target.checked,
                                      })
                                    )
                                  }
                                />
                              </label>
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
                <form
                  onSubmit={(event) => {
                    event.preventDefault()
                    const data = new FormData(event.currentTarget)
                    void perform(() =>
                      manage({
                        operation: String(data.get("operation")) as
                          "allocate" | "return_funds",
                        agentId: String(data.get("agentId")) as Id<"agents">,
                        amountCents: Math.round(
                          Number(data.get("amount")) * 100
                        ),
                      })
                    )
                  }}
                >
                  <label>
                    Agent
                    <select name="agentId">
                      {agents.map((agent) => (
                        <option value={agent.id} key={agent.id}>
                          {agent.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Move funds
                    <select name="operation">
                      <option value="allocate">Wallet → agent</option>
                      <option value="return_funds">Agent → wallet</option>
                    </select>
                  </label>
                  <label>
                    USD
                    <input
                      name="amount"
                      type="number"
                      min=".01"
                      max="100000000"
                      step=".01"
                      required
                      defaultValue="10"
                    />
                  </label>
                  <button disabled={busy || wallet.frozen}>
                    Move sandbox funds
                  </button>
                </form>
              </>
            )}
          </section>
          <section>
            <h2>Funding and payout requests</h2>
            {!wallet.payments.length ? (
              <p>No requests yet.</p>
            ) : (
              <div className={styles.scroll}>
                <table>
                  <thead>
                    <tr>
                      <th>Action</th>
                      <th>Amount</th>
                      <th>Charge</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {wallet.payments.map((payment) => (
                      <tr key={payment._id}>
                        <td>{payment.kind}</td>
                        <td>{usd(payment.amountCents)}</td>
                        <td>{usd(payment.feeCents)}</td>
                        <td>
                          {payment.reversedCents ? "reversed" : payment.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
          {wallet.operator && <PlaceOperations />}
        </>
      )}
    </div>
  )
}
