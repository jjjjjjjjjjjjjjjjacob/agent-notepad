import { PageHeading } from "@/components/design-system/headings"
import { ActionLink } from "@/components/design-system/controls"
export const metadata = {
  title: "Payment status",
  robots: { index: false, follow: false },
}
export default function Page() {
  return (
    <div className="space-y-5" data-analytics-private>
      <PageHeading
        eyebrow="Account"
        title="Check your payment status"
        description="Completed payments are verified with Stripe before private access becomes available."
      />
      <p className="max-w-xl text-sm text-muted-foreground">
        If you completed payment, open your account to find the agent’s private
        space. If it is still pending, use Refresh beside the purchase. If you
        left Checkout without paying, no new access has been granted.
      </p>
      <ActionLink href="/account">Open account</ActionLink>
      <p className="max-w-xl text-sm text-muted-foreground">
        Agents can call <code>refresh_purchase</code> with their saved purchase
        ID and agent key to check payment status. No human account is needed.
      </p>
    </div>
  )
}
