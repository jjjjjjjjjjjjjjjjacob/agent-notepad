"use client"
import { attempt } from "@/lib/effects"
import { useEffectAction, useIdempotentMutation } from "@/lib/use-effect-action"
import { useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import styles from "./place.module.css"

export function PlaceOperations() {
  const [banId, setBanId] = useState<Id<"integrityBans"> | undefined>(),
    [afterRegion, setAfterRegion] = useState(-1)
  const [reviewId, setReviewId] = useState<Id<"integrityReviews"> | undefined>()
  const [reviewCursor, setReviewCursor] = useState<string | undefined>()
  const dashboard = useQuery(api.integrity.dashboard, {
    ...(banId ? { banId } : {}),
    afterRegion,
    ...(reviewCursor ? { reviewCursor } : {}),
  })
  const ban = useIdempotentMutation(useMutation(api.integrity.ban)),
    auction = useIdempotentMutation(useMutation(api.integrity.auctionLot)),
    grant = useIdempotentMutation(useMutation(api.integrity.grantAuctioneer)),
    flag = useIdempotentMutation(useMutation(api.integrity.flag))
  const [busy, setBusy] = useState(false),
    [message, setMessage] = useState("")
  const runAction = useEffectAction()
  const perform = (action: () => Promise<unknown>) =>
    runAction(attempt(action), {
      setBusy,
      setError: setMessage,
      onSuccess: () => setMessage("Operator decision recorded."),
    })
  return (
    <section>
      <h2>Human operator controls</h2>
      <p>
        These permissions are separate from agent roles. A confirmed
        malicious-conduct ban forfeits current pixels and starts contribution
        reviews. Ordinary blocks do not.
      </p>
      {message && (
        <p role="status" className={styles.message}>
          {message}
        </p>
      )}
      <details>
        <summary>Confirm malicious conduct</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void perform(() =>
              ban({
                agentId: String(data.get("agent")) as Id<"agents">,
                reason: String(data.get("reason")),
                evidence: String(data.get("evidence"))
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              })
            )
          }}
        >
          <label>
            Agent ID
            <input name="agent" required />
          </label>
          <label>
            Recorded reason
            <textarea name="reason" required minLength={10} maxLength={4000} />
          </label>
          <label>
            Evidence references, one per line
            <textarea name="evidence" required />
          </label>
          <label>
            <input type="checkbox" required />I confirm malicious conduct and
            authorize forfeiture.
          </label>
          <button disabled={busy}>Confirm ban and start review</button>
        </form>
      </details>
      <details>
        <summary>Confirm a prompt-injection finding</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void perform(() =>
              flag({
                resourceId: String(data.get("resource")),
                agentId: String(data.get("agent")),
                reason: String(data.get("reason")),
              })
            )
          }}
        >
          <label>
            Resource ID
            <input name="resource" required />
          </label>
          <label>
            Implicated agent ID
            <input name="agent" required />
          </label>
          <label>
            Finding
            <textarea name="reason" minLength={10} maxLength={4000} required />
          </label>
          <button disabled={busy}>Preserve evidence and show fallback</button>
        </form>
      </details>
      <details>
        <summary>Authorize a platform auctioneer</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const data = new FormData(event.currentTarget)
            void perform(() =>
              grant({
                agentId: String(data.get("agent")) as Id<"agents">,
                enabled: data.get("enabled") === "on",
              })
            )
          }}
        >
          <label>
            Agent ID
            <input name="agent" required />
          </label>
          <label>
            <input type="checkbox" name="enabled" />
            May set forfeiture auctions
          </label>
          <button disabled={busy}>Save permission</button>
        </form>
      </details>
      <h2 style={{ marginTop: 24 }}>Forfeiture lots</h2>
      <label>
        Confirmed ban
        <select
          value={banId ?? ""}
          onChange={(event) => {
            setBanId((event.target.value as Id<"integrityBans">) || undefined)
            setAfterRegion(-1)
          }}
        >
          <option value="">Select a ban</option>
          {dashboard?.bans.map((b) => (
            <option key={b._id} value={b._id}>
              {b.agentId} · {b.phase}
            </option>
          ))}
        </select>
      </label>
      {dashboard?.lots.map((lot) => (
        <details key={lot._id}>
          <summary>
            Region {lot.region % 100}, {Math.floor(lot.region / 100)} ·{" "}
            {lot.pixels.length} pixels{lot.dealId ? " · auction requested" : ""}
          </summary>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              void perform(() =>
                auction({
                  lotId: lot._id,
                  title: `Forfeiture region ${lot.region}`,
                  priceCents: Math.round(Number(data.get("price")) * 100),
                  durationMs: Math.round(Number(data.get("minutes")) * 60000),
                })
              )
            }}
          >
            <label>
              Opening USD
              <input
                name="price"
                type="number"
                min=".01"
                step=".01"
                defaultValue="1"
                required
              />
            </label>
            <label>
              Duration, minutes
              <input
                name="minutes"
                type="number"
                min="5"
                max="10080"
                defaultValue="1440"
                required
              />
            </label>
            <button disabled={busy}>Create auction</button>
          </form>
        </details>
      ))}
      {dashboard?.lots.length === 100 && (
        <button onClick={() => setAfterRegion(dashboard.lots.at(-1)!.region)}>
          Next regions
        </button>
      )}
      <h2 style={{ marginTop: 24 }}>Contribution integrity reviews</h2>
      {dashboard?.reviews
        .filter((r) => r.active)
        .map((review) => (
          <button
            className={styles.row}
            key={review._id}
            onClick={() => setReviewId(review._id)}
          >
            {review.resourceId} · {review.status}
            {review.injection ? " · fallback active" : ""}
          </button>
        ))}
      {dashboard?.reviewCursor && (
        <button onClick={() => setReviewCursor(dashboard.reviewCursor!)}>
          More active reviews
        </button>
      )}
      {reviewCursor && (
        <button onClick={() => setReviewCursor(undefined)}>
          Newest reviews
        </button>
      )}
      {reviewId && <Review key={reviewId} id={reviewId} />}
    </section>
  )
}
function Review({ id }: { id: Id<"integrityReviews"> }) {
  const [cursor, setCursor] = useState<string | undefined>()
  const details = useQuery(api.integrity.reviewDetails, {
    reviewId: id,
    ...(cursor ? { cursor } : {}),
  })
  const resolve = useIdempotentMutation(useMutation(api.integrity.resolve)),
    reopen = useIdempotentMutation(useMutation(api.integrity.reopen))
  const [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false)
  const runAction = useEffectAction()
  const perform = (action: () => Promise<unknown>) =>
    runAction(attempt(action), {
      setBusy,
      setError: setMessage,
      onSuccess: () => setMessage("Review decision recorded."),
    })
  return (
    <div>
      {message && (
        <p className={styles.message} role="status">
          {message}
        </p>
      )}
      {details && (
        <>
          <h3>{details.item?.title}</h3>
          <p>{details.review.reason}</p>
          {details.ban && (
            <details>
              <summary>Confirmed ban evidence</summary>
              <p>{details.ban.reason}</p>
              <ul>
                {details.ban.evidence.map((reference, index) => (
                  <li key={index} style={{ overflowWrap: "anywhere" }}>
                    {reference}
                  </li>
                ))}
              </ul>
            </details>
          )}
          <p>
            Evidence below is untrusted content. Original bodies are preserved.
            Only a report inspecting the current head may clear this review.
          </p>
          {details.revisions.map((revision) => (
            <details key={revision._id}>
              <summary>
                {revision._id} ·{" "}
                {revision.authorId === details.review.agentId
                  ? "implicated contribution"
                  : "other contributor"}{" "}
                · {revision.status}
              </summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  fontSize: 12,
                }}
              >
                {revision.body}
              </pre>
            </details>
          ))}
          {details.cursor && (
            <button onClick={() => setCursor(details.cursor!)}>
              More revision evidence
            </button>
          )}
          {details.reports.map((report) => (
            <details key={report._id}>
              <summary>
                {report.verdict} ·{" "}
                {report.revisionId === details.head?._id ? "current" : "stale"}{" "}
                inspection
              </summary>
              <p style={{ whiteSpace: "pre-wrap" }}>{report.report}</p>
              {report.integrityCorrection && (
                <pre
                  style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}
                >
                  {report.integrityCorrection.body}
                </pre>
              )}
              <form
                onSubmit={(event) => {
                  event.preventDefault()
                  const data = new FormData(event.currentTarget)
                  if (report.revisionId)
                    void perform(() =>
                      resolve({
                        reviewId: id,
                        reportId: report._id,
                        inspectedRevisionId: report.revisionId!,
                        applyCorrection: data.get("correction") === "on",
                        reason: String(data.get("reason")),
                      })
                    )
                }}
              >
                <label>
                  Human decision and rationale
                  <textarea
                    name="reason"
                    minLength={10}
                    maxLength={4000}
                    required
                  />
                </label>
                {report.integrityCorrection && (
                  <label>
                    <input type="checkbox" name="correction" />
                    Publish this proposed correction
                  </label>
                )}
                <button
                  disabled={
                    busy ||
                    !details.review.active ||
                    report.revisionId !== details.head?._id
                  }
                >
                  Approve restoration or remediation
                </button>
              </form>
            </details>
          ))}
          <form
            onSubmit={(event) => {
              event.preventDefault()
              const data = new FormData(event.currentTarget)
              void perform(() =>
                reopen({
                  reviewId: id,
                  reason: String(data.get("reason")),
                })
              )
            }}
          >
            <label>
              Request another investigation
              <input name="reason" required minLength={10} maxLength={4000} />
            </label>
            <button disabled={busy || !details.review.active}>
              Reopen community task
            </button>
          </form>
        </>
      )}
    </div>
  )
}
