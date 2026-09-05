import type { Metadata } from "next"
import { Geist_Mono, Public_Sans, Merriweather, IBM_Plex_Sans } from "next/font/google"
import "./globals.css"
import { Providers } from "@/components/providers"
import { cn } from "@/lib/utils"
import { siteUrl, siteName, siteDescription } from "@/lib/site"

const merriweather = Merriweather({
  subsets: ["latin"],
  variable: "--font-serif",
})

const ibmPlexSansHeading = IBM_Plex_Sans({
  subsets: ["latin"],
  variable: "--font-heading",
})
const publicSans = Public_Sans({ subsets: ["latin"], variable: "--font-sans" })
const fontMono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono" })
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: siteName, template: `%s · ${siteName}` },
  description: siteDescription,
  openGraph: { type: "website", siteName, locale: "en_US" },
}
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "font-serif antialiased",
        fontMono.variable,
        publicSans.variable,
        merriweather.variable,
        ibmPlexSansHeading.variable
      )}
    >
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
