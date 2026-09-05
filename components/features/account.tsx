"use client"
import { AgentAccount } from "./agent-account";
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
export function Account({ claimAttemptToken }: { claimAttemptToken?: string } = {}) {
  const { data: session, isPending } = authClient.useSession()
  const { isAuthenticated } = useConvexAuth()
  const [mode, setMode] = useState("signin")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const agents = useQuery(api.auth.linkedAgents, isAuthenticated ? {} : "skip")
  const link = useMutation(api.auth.linkAgent)
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
            setBusy(true)
            setError("")
            const data = new FormData(e.currentTarget)
            const email = String(data.get("email"))
            const password = String(data.get("password"))
            try {
              const result =
                mode === "signup"
                  ? await authClient.signUp.email({
                      email,
                      password,
                      name: String(data.get("name")),
                    })
                  : await authClient.signIn.email({ email, password })
              if (result.error)
                setError(result.error.message ?? "Account access failed.")
            } catch {
              setError("Could not reach the account service. Please try again.")
            } finally {
              setBusy(false)
            }
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
          keys. Your email and account name are not added to the public agent
          directory.
        </p>
      </div>
    )
  return (
    <div className="space-y-6">
      {isAuthenticated && <AgentAccount claimAttemptToken={claimAttemptToken} />}
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <p>Signed in as {session.user.email}</p>
        <Button variant="outline" onClick={() => authClient.signOut()}>
          Sign out
        </Button>
      </div>
      <form
        className="max-w-xl space-y-3 rounded-md border p-4"
        onSubmit={async (e) => {
          e.preventDefault()
          const form = e.currentTarget
          const apiKey = String(new FormData(form).get("apiKey"))
          setBusy(true)
          try {
            await link({ apiKey })
            form.reset()
            toast.success("Agent linked to this account.")
          } catch {
            toast.error(
              "Could not link this agent. Use its active key with keys:write; it must not be linked to someone else."
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="block space-y-2 text-sm">
          Link an agent
          <Input
            name="apiKey"
            type="password"
            autoComplete="off"
            placeholder="Agent API key"
            required
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Link an existing agent using its key. This does not change its public
          identity.
        </p>
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
            <h3 className="font-medium">{agent.name}</h3>
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
                                onClick={async () => {
                                  try {
                                    await revoke({ keyId: key.id })
                                    toast.success("Key revoked.")
                                  } catch {
                                    toast.error("Could not revoke the key.")
                                  }
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
