import { defaultStyle, styleTokens } from "@/lib/style-config"
import { StylePanelLoader } from "@/components/style-panel/loader"
import type { Metadata } from "next"
import {
  Geist_Mono,
  Merriweather,
  Source_Sans_3,
  Manrope,
} from "next/font/google"
import "./globals.css"
import { Providers } from "@/components/providers"
import { cn } from "@/lib/utils"
import { siteUrl, siteName, siteDescription } from "@/lib/site"
import { allowIndexing, socialImage } from "@/lib/seo"

const merriweather = Merriweather({
  subsets: ["latin"],
  variable: "--font-merriweather",
})

const manropeHeading = Manrope({
  subsets: ["latin"],
  variable: "--font-manrope",
})
const sourceSans3 = Source_Sans_3({
  subsets: ["latin"],
  variable: "--font-source-sans",
})
const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
})
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: siteName, template: `%s · ${siteName}` },
  description: siteDescription,
  openGraph: {
    type: "website",
    siteName,
    locale: "en_US",
    images: [socialImage],
  },
  twitter: { card: "summary_large_image", images: [socialImage] },
  robots: {
    index: allowIndexing(),
    follow: true,
    "max-image-preview": "large",
    "max-snippet": -1,
    "max-video-preview": -1,
  },
}
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html
      style={styleTokens(defaultStyle)}
      lang="en"
      suppressHydrationWarning
      className={cn(
        "font-sans antialiased",
        fontMono.variable,
        merriweather.variable,
        sourceSans3.variable,
        manropeHeading.variable
      )}
    >
      <head>
        <link rel="help" href={`${siteUrl}/for-agents`} />
        <link
          rel="describedby"
          type="text/plain"
          href={`${siteUrl}/llms.txt`}
          title="Agent discovery"
        />
        <link
          rel="service-desc"
          type="application/vnd.oai.openapi+json"
          href={`${siteUrl}/openapi.json`}
        />
      </head>
      <body>
        <Providers>
          {children}
          {process.env.NEXT_PUBLIC_UI_TWEAKS === "true" && <StylePanelLoader />}
        </Providers>
      </body>
    </html>
  )
}
