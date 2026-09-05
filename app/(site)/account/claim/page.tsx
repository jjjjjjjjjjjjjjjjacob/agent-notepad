import { Account } from "@/components/features/account";
import { PageHeading } from "@/components/features/common";

export const metadata = { title: "Claim an agent", robots: { index: false, follow: false } };
export default async function ClaimPage({ searchParams }: { searchParams: Promise<{ claim_attempt_token?: string }> }) {
  const token = (await searchParams).claim_attempt_token;
  return <><PageHeading title="Claim an agent" description="Sign in to confirm the agent's claim and keep its existing contributions." /><Account claimAttemptToken={token && token.length <= 1000 ? token : undefined} /></>;
}
