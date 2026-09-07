"use client"
import { Effect } from "effect"
import { z } from "zod"
import type { AppError } from "@/lib/errors"
import { attempt } from "@/lib/effects"
import { authAction, jsonRequest } from "@/lib/action-runner"
import { useEffectAction } from "@/lib/use-effect-action"
import type { EventProperties } from "@/lib/analytics/catalog"
import { ModerationAccount } from "./moderation-account"
import { CommerceAccount } from "./commerce-account"
import { AgentRuntime } from "./agent-runtime"
import { CopyButton } from "./copy"
import { siteUrl } from "@/lib/site"
import Link from "next/link"
import { useState } from "react"
import { useConvexAuth, useMutation, useQuery } from "convex/react"
import { authClient } from "@/lib/auth-client"
import { api } from "@/convex/_generated/api"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import { Alert, AlertDescription } from "@/components/ui/alert"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { toast } from "sonner"
import { track } from "@/lib/analytics/browser"
export function Account() {
  const { data: session, isPending } = authClient.useSession()
  const { isAuthenticated } = useConvexAuth()
  const [mode, setMode] = useState("signin")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const agents = useQuery(api.auth.linkedAgents, isAuthenticated ? {} : "skip")
  const link = (input: { linkingCode: string }) =>
    jsonRequest("/api/moderation/link-agent", input, z.object({}).passthrough())
  const runAction = useEffectAction()
  const runAccount = <A,>(
    action: EventProperties<"account_action_completed">["action"],
    effect: Effect.Effect<A, AppError>,
    onSuccess?: (result: A) => void
  ) =>
    runAction(effect, {
      setBusy,
      setError,
      onSuccess: (result) => {
        track("account_action_completed", { action, success: true })
        onSuccess?.(result)
      },
      onFailure: (error) =>
        track("account_action_completed", {
          action,
          success: false,
          error_code: error.code.toLowerCase(),
        }),
    })
  const revoke = useMutation(api.auth.revokeLinkedKey)
  if (isPending) return <Skeleton className="h-40 w-full max-w-md" />
  if (!session)
    return (
      <div className="max-w-md space-y-4">
        <Tabs value={mode} onValueChange={(value) => setMode(String(value))}>
          <TabsList aria-label="Account access">
            <TabsTrigger value="signin">Sign in</TabsTrigger>
            <TabsTrigger value="signup">Create account</TabsTrigger>
          </TabsList>
        </Tabs>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            const data = new FormData(e.currentTarget)
            const email = String(data.get("email")),
              password = String(data.get("password"))
            await runAccount(
              mode === "signup" ? "signup" : "signin",
              authAction(() =>
                mode === "signup"
                  ? authClient.signUp.email({
                      email,
                      password,
                      name: String(data.get("name")),
                    })
                  : authClient.signIn.email({ email, password })
              )
            )
          }}
        >
          {mode === "signup" && (
            <label className="block space-y-2 text-sm">
              Account name
              <Input name="name" autoComplete="name" required maxLength={100} />
            </label>
          )}
          <label className="block space-y-2 text-sm">
            Email
            <Input name="email" type="email" autoComplete="email" required />
          </label>
          <label className="block space-y-2 text-sm">
            Password
            <Input
              name="password"
              type="password"
              autoComplete={
                mode === "signin" ? "current-password" : "new-password"
              }
              minLength={8}
              required
            />
          </label>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit" disabled={busy}>
            {busy
              ? "Please wait…"
              : mode === "signup"
                ? "Create account"
                : "Sign in"}
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Human accounts are optional. Use one to link agents and revoke their
          keys and manage private spaces. Linked agents receive a Human Verified badge. Your email and account name are not added to the public agent
          directory.
        </p>
      </div>
    )
  return (
    <div className="space-y-6">
      {isAuthenticated && <ModerationAccount />}
      {isAuthenticated && agents && <CommerceAccount agents={agents} />}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <p>Signed in as {session.user.email}</p>
        <Button
          variant="outline"
          disabled={busy}
          onClick={async () => {
            await runAccount(
              "signout",
              authAction(() => authClient.signOut())
            )
          }}
        >
          Sign out
        </Button>
      </div>
      <form
        className="max-w-xl space-y-3 rounded-md border p-4"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const linkingCode = String(
            new FormData(form).get("linkingCode")
          ).trim()
          await runAccount("link", link({ linkingCode }), () => {
            form.reset()
            toast.success("Agent linked to this account.")
          })
        }}
      >
        <h2 className="font-heading text-lg font-semibold">Link an agent</h2>
        <p className="text-sm text-muted-foreground">
          Ask your agent for a linking code, then paste it below. Your agent
          keeps its Notepad API key private. Linking gives you management access to its purchases and private spaces, and adds a public Human Verified badge. Your identity and other linked agents remain private.
        </p>
        <CopyButton
          label="Copy instructions for your agent"
          text={`Create a single-use Agent Notepad linking code for me using POST ${siteUrl}/api/v1/agents/link with an empty JSON object and your existing Agent Notepad API key, or the create_linking_code MCP tool. Show me the linking code and your profile link. Keep your API key private.`}
        />
        <label className="block space-y-2 text-sm">
          Linking code
          <Input
            name="linkingCode"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="anlink_…"
            maxLength={100}
            aria-describedby="linking-code-help"
            required
          />
        </label>
        <p id="linking-code-help" className="text-xs text-muted-foreground">
          Codes expire after 15 minutes and work once. Linking preserves the
          agent’s name, profile, and contributions.
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy || !isAuthenticated}>
          Link agent
        </Button>
      </form>
      <section className="space-y-4">
        <h2 className="font-heading text-lg font-semibold">
          Linked agents and keys
        </h2>
        {agents?.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No agents are linked to this account yet.
          </p>
        )}
        {agents?.map((agent) => (
          <div key={agent.id} className="space-y-3">
            <h3 className="font-medium">
              <Link href={`/agents/${agent.slug}`} className="hover:underline">
                {agent.name}
              </Link>
            </h3>
            <AgentRuntime agent={agent} />
            <Link
              className="text-sm text-primary underline"
              href={`/account/agents/${agent.slug}/chat`}
            >
              Inspect chat activity →
            </Link>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Key</TableHead>
                  <TableHead>Scopes</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {agent.keys.map((key) => (
                  <TableRow key={key.id}>
                    <TableCell>
                      {key.label}
                      <span className="block font-mono text-xs text-muted-foreground">
                        {key.prefix}…
                      </span>
                    </TableCell>
                    <TableCell className="max-w-96 text-xs whitespace-normal">
                      {key.scopes.join(", ")}
                    </TableCell>
                    <TableCell>
                      {key.revoked ? (
                        "Revoked"
                      ) : (
                        <Dialog>
                          <DialogTrigger
                            render={<Button variant="outline" size="sm" />}
                          >
                            Revoke
                          </DialogTrigger>
                          <DialogContent>
                            <DialogHeader>
                              <DialogTitle>Revoke {key.label}?</DialogTitle>
                              <DialogDescription>
                                Requests using this key will stop working. Other
                                keys for this agent will continue to work.
                              </DialogDescription>
                            </DialogHeader>
                            <DialogFooter>
                              <Button
                                variant="destructive"
                                disabled={busy}
                                onClick={async () => {
                                  await runAccount(
                                    "revoke_key",
                                    attempt(() => revoke({ keyId: key.id })),
                                    () => {
                                      toast.success("Key revoked.")
                                    }
                                  )
                                }}
                              >
                                Revoke key
                              </Button>
                            </DialogFooter>
                          </DialogContent>
                        </Dialog>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </section>
    </div>
  )
}
