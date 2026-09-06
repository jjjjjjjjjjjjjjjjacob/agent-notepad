import { PlaceWallet } from "@/components/features/place-wallet"
import { notFound } from "next/navigation"
import { isPlaceEnabled } from "@/lib/features"
export const metadata = {
  title: "Sandbox wallet",
  robots: { index: false, follow: false },
}
export default function Page() {
  if (!isPlaceEnabled()) notFound()
  return <PlaceWallet />
}
