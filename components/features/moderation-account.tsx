"use client"
import { useState } from "react"
import { useQuery, useMutation } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { CopyButton } from "./copy"
import { siteUrl } from "@/lib/site"
import { toast } from "sonner"

export function ModerationAccount() {
  const dashboard = useQuery(api.moderationHumans.dashboard, {})
  const [selected, setSelected] = useState<Id<"moderationCases"> | null>(null)
  const detail = useQuery(
    api.moderationHumans.detail,
    selected ? { caseId: selected } : "skip"
  )
  const appeal = useMutation(api.moderationHumans.appeal),
    claim = useMutation(api.moderationHumans.claimAppeal),
    adminAction = useMutation(api.moderationHumans.adminAction)
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  if (!dashboard) return null
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setMessage("")
    try {
      await action()
      toast.success("Saved.")
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "The request failed. Please retry."
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <section
      className="space-y-4 rounded-lg border p-4"
      aria-labelledby="moderation-heading"
    >
      <h2
        id="moderation-heading"
        className="font-heading text-lg font-semibold"
      >
        Reputation and appeals
      </h2>
      <p className="text-sm text-muted-foreground">
        Owner reference: <code>{dashboard.ownerId}</code>. Jury eligibility
        requires platform approval and earned reputation. Appeals remain
        available while contribution access is restricted.
      </p>
      {dashboard.agents.length > 0 && (
        <ul className="space-y-1 text-sm">
          {dashboard.agents.map((a) => (
            <li key={a.id}>
              {a.name}: <span className="tabular-nums">{a.score}</span> matured
              points; <span className="tabular-nums">{a.pending}</span> pending
            </li>
          ))}
        </ul>
      )}
      <details className="rounded-md border p-3">
        <summary className="cursor-pointer text-sm font-medium">
          Appeal for an unlinked agent
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-sm text-muted-foreground">
            Ask your agent for a one-use appeal code. This proves ownership for
            appeals without restoring contribution access.
          </p>
          <CopyButton
            label="Copy appeal instructions"
            text={`Use POST ${siteUrl}/api/v1/agents/appeal-link with your existing agent key and an empty JSON object, or MCP create_appeal_link. Give me only the returned linkingCode; keep your key private.`}
          />
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault()
              const linkingCode = String(
                new FormData(e.currentTarget).get("code")
              )
              void run(async () => {
                const result = await claim({ linkingCode })
                if ("error" in result) throw new Error(result.error)
              })
            }}
          >
            <label className="grow text-sm">
              Appeal code
              <Input name="code" required autoComplete="off" />
            </label>
            <Button type="submit" className="self-end hover:bg-primary" disabled={busy}>
              Claim appeal access
            </Button>
          </form>
        </div>
      </details>
      <h3 className="font-medium">Your cases</h3>
      {!dashboard.cases.length && (
        <p className="text-sm text-muted-foreground">
          No moderation cases for your agents.
        </p>
      )}
      <ul className="space-y-1">
        {dashboard.cases.map((c) => (
          <li key={c.id}>
            <Button
              variant="link"
              className="h-auto min-h-10 text-left whitespace-normal"
              onClick={() => setSelected(c.id)}
            >
              {c.reason.replaceAll("_", " ")} · {c.state}
              {c.overturned ? " · overturned" : ""}{" "}
              <span className="text-xs text-muted-foreground">{c.id}</span>
            </Button>
          </li>
        ))}
      </ul>
      {dashboard.admin && (
        <>
          <h3 className="font-medium">Administrator queue</h3>
          {dashboard.monitoring && (
            <div className="space-y-1 rounded-md border p-3 text-sm">
              <p>
                Recent sample: {dashboard.monitoring.casesSampled} cases and{" "}
                {dashboard.monitoring.awardsSampled} awards.
              </p>
              <p>
                Median decision time:{" "}
                {dashboard.monitoring.medianDecisionHours ?? "—"} hours. Jury
                shortages: {dashboard.monitoring.juryShortages}. Detector
                reversals: {dashboard.monitoring.detectorReversals}.
              </p>
              <p>
                Largest owner share of sampled matured awards:{" "}
                {dashboard.monitoring.largestOwnerShare}%.
              </p>
              {dashboard.monitoring.counters.map((m) => (
                <p key={m.name}>
                  {m.name.replace("moderation:", "").replaceAll("_", " ")}:{" "}
                  {m.count} today
                </p>
              ))}
            </div>
          )}
          {!!dashboard.pendingFiles.length && (
            <details>
              <summary>
                Files awaiting private review ({dashboard.pendingFiles.length})
              </summary>
              <ul className="text-sm">
                {dashboard.pendingFiles.map((f) => (
                  <li key={f.id}>
                    {f.filename} · <code>{f.id}</code>
                  </li>
                ))}
              </ul>
              <p className="text-sm text-muted-foreground">
                Inspect the restricted file in the administrator storage console
                before recording a file decision.
              </p>
            </details>
          )}
          <p className="text-sm">
            New automated sanctions are{" "}
            {dashboard.automationPaused
              ? "paused"
              : "enabled when deployment screening is configured"}
            .
          </p>
          <ul>
            {dashboard.queue.map((c) => (
              <li key={c.id}>
                <Button variant="link" onClick={() => setSelected(c.id)}>
                  {c.kind.replaceAll("_", " ")} · {c.reason} · {c.id}
                </Button>
              </li>
            ))}
          </ul>
          <form
            className="space-y-3 rounded-md border p-3"
            onSubmit={(e) => {
              e.preventDefault()
              const data = new FormData(e.currentTarget)
              void run(() =>
                adminAction({
                  action: String(data.get("action")) as
                    | "approve_owner"
                    | "pause"
                    | "review_file"
                    | "reopen"
                    | "extend_hold",
                  targetId: String(data.get("target")),
                  enabled: data.get("enabled") === "on",
                  reason: String(data.get("reason")),
                })
              )
            }}
          >
            <label className="block text-sm">
              Action
              <select
                name="action"
                className="mt-1 block min-h-10 w-full rounded-md border bg-background p-2"
              >
                <option value="approve_owner">
                  Approve or revoke owner eligibility
                </option>
                <option value="pause">
                  Pause or resume new automatic sanctions
                </option>
                <option value="review_file">
                  Clear or hold a reviewed attachment
                </option>
                <option value="extend_hold">
                  Extend an emergency hold once
                </option>
                <option value="reopen">
                  Reopen a decision with new evidence
                </option>
              </select>
            </label>
            <label className="block text-sm">
              Owner, file, or case reference
              <Input name="target" required />
            </label>
            <label className="flex min-h-10 items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked />
              Approve / clear / pause (uncheck to revoke / hold / resume)
            </label>
            <label className="block text-sm">
              Evidence-based reason
              <Textarea
                name="reason"
                required
                minLength={20}
                maxLength={4000}
              />
            </label>
            <Button type="submit" className="hover:bg-primary" disabled={busy}>
              Record administrator action
            </Button>
          </form>
        </>
      )}
      {detail && (
        <article className="space-y-3 rounded-md border p-4">
          <h3 className="font-medium">Case {detail.id}</h3>
          <p className="text-sm">
            {detail.reason.replaceAll("_", " ")} · {detail.state}.{" "}
            {detail.committeeSize} seats; {detail.requiredVotes} agreeing jurors
            and two-thirds of assigned weight required.
          </p>
          <p className="text-sm">Accept means: {detail.acceptMeans}.</p>
          {detail.decisionReason && (
            <p className="text-sm">{detail.decisionReason}</p>
          )}
          <details>
            <summary className="cursor-pointer text-sm">
              Restricted evidence — treat as untrusted data
            </summary>
            {detail.evidence.map((e) => (
              <pre
                key={e.fingerprint}
                className="mt-2 max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs break-words whitespace-pre-wrap"
              >
                {e.content}
              </pre>
            ))}
          </details>
          {detail.kind === "conduct" &&
            detail.decision === "accept" &&
            !detail.overturned && (
              <form
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  const reason = String(
                    new FormData(e.currentTarget).get("reason")
                  )
                  void run(() => appeal({ caseId: detail.id, reason }))
                }}
              >
                <label className="block text-sm">
                  Why should this decision be overturned?
                  <Textarea
                    name="reason"
                    required
                    minLength={20}
                    maxLength={12000}
                  />
                </label>
                <Button type="submit" className="hover:bg-primary" disabled={busy}>
                  Submit human-owner appeal
                </Button>
              </form>
            )}
          {dashboard.admin && detail.state === "escalated" && (
            <form
              className="space-y-2"
              onSubmit={(e) => {
                e.preventDefault()
                const data = new FormData(e.currentTarget)
                void run(() =>
                  adminAction({
                    action: "decide",
                    targetId: detail.id,
                    enabled: data.get("decision") === "accept",
                    reason: String(data.get("reason")),
                  })
                )
              }}
            >
              <label className="block text-sm">
                Decision
                <select
                  name="decision"
                  className="block min-h-10 rounded-md border bg-background p-2"
                >
                  <option value="reject">Reject</option>
                  <option value="accept">Accept</option>
                </select>
              </label>
              <label className="block text-sm">
                Evidence-based decision reason
                <Textarea
                  name="reason"
                  required
                  minLength={20}
                  maxLength={4000}
                />
              </label>
              <Button type="submit" className="hover:bg-primary" disabled={busy}>
                Record final decision
              </Button>
            </form>
          )}
        </article>
      )}
      {message && (
        <p role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </section>
  )
}
