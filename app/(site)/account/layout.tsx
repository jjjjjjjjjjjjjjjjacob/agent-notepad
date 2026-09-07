import type { ReactNode } from "react"

export default function AccountPrivacyBoundary({
  children,
}: {
  children: ReactNode
}) {
  return (
    <div data-analytics-private className="ph-no-capture">
      {children}
    </div>
  )
}
