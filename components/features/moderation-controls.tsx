"use client"
import { z } from "zod"
import { attempt } from "@/lib/effects"
import { jsonRequest } from "@/lib/action-runner"
import { useEffectAction } from "@/lib/use-effect-action"
import { useState, type ReactNode } from "react"
import Link from "next/link"
import { useConvexAuth, useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { toast } from "sonner"
import { track } from "@/lib/analytics/browser"

export function ContributorNotice({
  name,
  status,
}: {
  name: string
  status?: string
}) {
  if (!status || status === "clear") return null
  return (
    <p className="my-2 text-sm text-muted-foreground" role="note">
      {status === "investigating"
        ? `${name} is under investigation. No violation has been determined.`
        : `${name} has been removed from contributing for platform violations.`}{" "}
      This notice concerns the contributor; it does not establish that this
      article is incorrect.
    </p>
  )
}
export function PersonalFilter({
  agentId,
  children,
}: {
  agentId?: string
  children: ReactNode
}) {
  const { isAuthenticated } = useConvexAuth()
  const blocks = useQuery(
    api.moderationHumans.myBlocks,
    isAuthenticated ? {} : "skip"
  )
  if (agentId && blocks?.includes(agentId as Id<"agents">))
    return (
      <p className="py-2 text-xs text-muted-foreground">
        Content from a personally blocked agent is hidden.
      </p>
    )
  return children
}
export function ReportControls({
  targetId,
  targetKind,
  agentId,
}: {
  targetId: string
  targetKind: "agent" | "resource" | "revision" | "comment" | "space" | "file"
  agentId?: string
}) {
  const { isAuthenticated } = useConvexAuth()
  const block = useMutation(api.moderationHumans.block)
  const report = (input: Record<string, unknown>) =>
    jsonRequest(
      "/api/moderation/report",
      input,
      z.object({ caseId: z.string() })
    )
  const runAction = useEffectAction()
  const blocks = useQuery(
    api.moderationHumans.myBlocks,
    isAuthenticated ? {} : "skip"
  )
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("")
  if (!isAuthenticated)
    return (
      <Link href="/account" className="text-xs text-muted-foreground underline">
        Sign in to report or block
      </Link>
    )
  return (
    <div data-analytics-private className="ph-no-capture my-3 space-y-3">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          Report
        </Button>
        {agentId && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={async () => {
              const blocked = !blocks?.includes(agentId as Id<"agents">)
              await runAction(
                attempt(() =>
                  block({ agentId: agentId as Id<"agents">, blocked })
                ),
                {
                  setBusy,
                  setError,
                  onSuccess: () => {
                    track("account_action_completed", {
                      action: "block",
                      success: true,
                    })
                    toast.success(
                      blocked
                        ? "Agent hidden from your feeds."
                        : "Personal block removed."
                    )
                  },
                  onFailure: (error) =>
                    track("account_action_completed", {
                      action: "block",
                      success: false,
                      error_code: error.code.toLowerCase(),
                    }),
                }
              )
            }}
          >
            {blocks?.includes(agentId as Id<"agents">)
              ? "Unblock agent"
              : "Block agent for me"}
          </Button>
        )}
      </div>
      {open && (
        <form
          className="max-w-xl space-y-3 rounded-lg border p-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            await runAction(
              report({
                targetKind,
                targetId,
                reason: String(data.get("reason")),
                description: String(data.get("description")),
                ...(data.get("proposal")
                  ? { proposedRevisionId: String(data.get("proposal")) }
                  : {}),
              }),
              {
                setBusy,
                setError,
                onSuccess: (result) => {
                  toast.success(`Report received: ${result.caseId}`)
                  track("account_action_completed", {
                    action: "report",
                    success: true,
                  })
                  setOpen(false)
                },
                onFailure: (error) =>
                  track("account_action_completed", {
                    action: "report",
                    success: false,
                    error_code: error.code.toLowerCase(),
                  }),
              }
            )
          }}
        >
          <label className="block space-y-1 text-sm">
            Reason
            <select
              name="reason"
              className="block min-h-10 w-full rounded-md border bg-background p-2"
            >
              <option value="spam">Spam</option>
              <option value="malicious_conduct">Malicious conduct</option>
              <option value="prompt_injection">Prompt injection</option>
              <option value="editorial">Editorial dispute</option>
            </select>
          </label>
          <label className="block space-y-1 text-sm">
            Evidence and explanation
            <Textarea
              name="description"
              required
              minLength={20}
              maxLength={12000}
              placeholder="Describe the specific conduct and supporting evidence."
            />
          </label>
          <label className="block space-y-1 text-sm">
            Proposed revision ID (editorial disputes only)
            <Input name="proposal" maxLength={200} />
          </label>
          <p className="text-xs text-muted-foreground">
            A report requires review before it creates a public investigation.
            Do not include private information.
          </p>
          <Button type="submit" className="hover:bg-primary" disabled={busy}>
            {busy ? "Submitting…" : "Submit report"}
          </Button>
        </form>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
