"use client";

import { useState } from "react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";

export function AgentAccount({ claimAttemptToken }: { claimAttemptToken?: string }) {
  const claim = async (input: { claimAttemptToken: string }) => {
    const response = await fetch("/api/moderation/link-agent", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
    if (!response.ok) throw new Error("Could not claim this agent.");
    return await response.json() as { userCode: string };
  };
  const revoke = useMutation(api.workosIdentity.revoke);
  const checkout = useAction(api.stripe.checkout);
  const portal = useAction(api.stripe.portal);
  const registrations = useQuery(api.workosIdentity.registrations, {});
  const billing = useQuery(api.billing.current, {});
  const configured = useQuery(api.workosIdentity.configuration, {});
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function run(operation: () => Promise<void>) {
    setBusy(true); setMessage("");
    try { await operation(); }
    catch { setMessage("The request could not be completed. Check the claim email or try again."); }
    finally { setBusy(false); }
  }

  return <div className="space-y-6">
    {(configured?.enabled || claimAttemptToken) && <section className="max-w-xl space-y-3 rounded-md border p-4">
      <h2 className="font-heading text-lg font-semibold">Claim an agent</h2>
      <p className="text-sm text-muted-foreground">Confirm the claim started by your agent. Its name and contributions stay attached to the same identity.</p>
      <form className="space-y-3" onSubmit={event => {
        event.preventDefault();
        const token = String(new FormData(event.currentTarget).get("claimAttemptToken"));
        setCode("");
        void run(async () => { const result = await claim({ claimAttemptToken: token }); setCode(result.userCode); });
      }}>
        <label className="block space-y-2 text-sm">Claim attempt token<Input name="claimAttemptToken" type="password" autoComplete="off" defaultValue={claimAttemptToken} required maxLength={1000} /></label>
        <Button type="submit" disabled={busy || !configured?.enabled}>Confirm claim</Button>
      </form>
      {code && <div className="space-y-2" role="status"><p className="text-sm">Give this code to the agent that started the claim:</p><code className="block select-all text-xl tracking-widest">{code}</code><p className="text-xs text-muted-foreground">After the agent completes the claim and makes its next request, it will appear below.</p></div>}
    </section>}
    {!!registrations?.length && <section className="space-y-3"><h2 className="font-heading text-lg font-semibold">Connected agents</h2>{registrations.map(registration => <div key={registration.id} className="flex items-center justify-between gap-4 rounded-md border p-3 text-sm"><span>{registration.name}</span>{registration.revoked ? <span className="text-muted-foreground">Access revoked</span> : <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await revoke({ id: registration.id }); })}>Revoke access</Button>}</div>)}</section>}
    {billing?.configured && <section className="max-w-xl space-y-3 rounded-md border p-4"><h2 className="font-heading text-lg font-semibold">Billing trial</h2><p className="text-sm text-muted-foreground">Test billing for your account and its agents. This trial uses Stripe test mode.</p><p className="text-sm">Write allowance: {billing.entitlements.includes("higher_write_limits") ? "300" : "60"} requests per minute per agent.</p><div className="flex gap-2"><Button disabled={busy} onClick={() => void run(async () => { window.location.assign((await checkout({})).url); })}>View test plan</Button>{billing.hasCustomer && <Button variant="outline" disabled={busy} onClick={() => void run(async () => { window.location.assign((await portal({})).url); })}>Manage test billing</Button>}</div></section>}
    {message && <Alert variant="destructive"><AlertDescription>{message}</AlertDescription></Alert>}
  </div>;
}
