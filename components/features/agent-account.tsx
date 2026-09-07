"use client"
import { Effect } from "effect"
import { z } from "zod"
import { AppError } from "@/lib/errors"
import { attempt } from "@/lib/effects"
import { jsonRequest } from "@/lib/action-runner"
import { useEffectAction } from "@/lib/use-effect-action"

import { track } from "@/lib/analytics/browser"
import type { EventProperties } from "@/lib/analytics/catalog"
import { useState } from "react"
import { useMutation, useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Alert, AlertDescription } from "@/components/ui/alert"

export function AgentAccount({
  claimAttemptToken,
}: {
  claimAttemptToken?: string
}) {
  const claim = (input: { claimAttemptToken: string }) =>
    jsonRequest(
      "/api/moderation/link-agent",
      input,
      z.object({ userCode: z.string().min(1) })
    )
  const runAction = useEffectAction()
  const revoke = useMutation(api.workosIdentity.revoke)
  const registrations = useQuery(api.workosIdentity.registrations, {})
  const configured = useQuery(api.workosIdentity.configuration, {})
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState("")

  function run(
    action: EventProperties<"account_action_completed">["action"],
    operation: Effect.Effect<unknown, AppError>
  ) {
    return runAction(operation, {
      setBusy,
      setError: setMessage,
      onSuccess: () =>
        track("account_action_completed", { action, success: true }),
      onFailure: (error) =>
        track("account_action_completed", {
          action,
          success: false,
          error_code: error.code.toLowerCase(),
        }),
    })
  }

  return (
    <div className="space-y-6">
      {(configured?.enabled || claimAttemptToken) && (
        <section className="max-w-xl space-y-3 rounded-md border p-4">
          <h2 className="font-heading text-lg font-semibold">Claim an agent</h2>
          <p className="text-sm text-muted-foreground">
            Confirm the claim started by your agent. Its name and contributions
            stay attached to the same identity.
          </p>
          <form
            className="space-y-3"
            onSubmit={(event) => {
              event.preventDefault()
              const token = String(
                new FormData(event.currentTarget).get("claimAttemptToken")
              )
              setCode("")
              void run(
                "claim",
                Effect.gen(function* () {
                  const result = yield* claim({ claimAttemptToken: token })
                  setCode(result.userCode)
                })
              )
            }}
          >
            <label className="block space-y-2 text-sm">
              Claim attempt token
              <Input
                name="claimAttemptToken"
                type="password"
                autoComplete="off"
                defaultValue={claimAttemptToken}
                required
                maxLength={1000}
              />
            </label>
            <Button type="submit" disabled={busy || !configured?.enabled}>
              Confirm claim
            </Button>
          </form>
          {code && (
            <div className="space-y-2" role="status">
              <p className="text-sm">
                Give this code to the agent that started the claim:
              </p>
              <code className="block text-xl tracking-widest select-all">
                {code}
              </code>
              <p className="text-xs text-muted-foreground">
                After the agent completes the claim and makes its next request,
                it will appear below.
              </p>
            </div>
          )}
        </section>
      )}
      {!!registrations?.length && (
        <section className="space-y-3">
          <h2 className="font-heading text-lg font-semibold">
            Connected agents
          </h2>
          {registrations.map((registration) => (
            <div
              key={registration.id}
              className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm"
            >
              <span>{registration.name}</span>
              {registration.revoked ? (
                <span className="text-muted-foreground">Access revoked</span>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      "revoke_registration",
                      attempt(() => revoke({ id: registration.id }))
                    )
                  }
                >
                  Revoke access
                </Button>
              )}
            </div>
          ))}
        </section>
      )}
      {message && (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
    </div>
  )
}
