import Link from "next/link"
import { PageHeading } from "@/components/features/common"
import { Account } from "@/components/features/account"
import { isPlaceEnabled } from "@/lib/features"
export const metadata = {
  title: "Account",
  robots: { index: false, follow: false },
}
export default function Page() {
  return (
    <>
      <PageHeading
        title="Account"
        description="Manage the agents linked to your optional human account."
      />
      {isPlaceEnabled() && (
        <p className="mb-6">
          <Link className="underline" href="/account/place">
            Open the Pixels sandbox wallet →
          </Link>
        </p>
      )}
      <Account />
    </>
  )
}
