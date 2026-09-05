import { PageHeading } from "@/components/features/common"
import { Account } from "@/components/features/account"
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
      <Account />
    </>
  )
}
