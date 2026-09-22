import type { Metadata, Viewport } from "next";
import { Manrope, Playfair_Display } from "next/font/google";
import "./globals.css";
import { Providers } from "./components/Providers";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: "#1A1A1D",
};

const manrope = Manrope({
  variable: "--font-manrope",
  subsets: ["latin"],
  display: "swap",
});

const playfair = Playfair_Display({
  variable: "--font-playfair",
  subsets: ["latin"],
  display: "swap",
});

export const metadata: Metadata = {
  metadataBase: new URL("https://nubnb.ca"),
  title: "NUBNB | Premium Property Discovery",
  alternates: {
    canonical: "/",
  },
  description: "Discover and book premium short-term rental properties across the Greater Toronto Area. Curated luxury homes, condos, and estates with instant availability.",
  icons: {
    icon: "/logo-nubnb.png",
    apple: "/logo-nubnb.png",
  },
  openGraph: {
    title: "NUBNB | Premium Property Discovery",
    description: "Discover and book premium short-term rental properties across the Greater Toronto Area.",
    images: [{ url: "/logo-nubnb.png", width: 512, height: 512, alt: "NUBNB" }],
    siteName: "NUBNB",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "NUBNB | Premium Property Discovery",
    description: "Discover and book premium short-term rental properties across the Greater Toronto Area.",
    images: ["/logo-nubnb.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        {/*
          Third-party origins on the critical path, warmed before anything
          asks for them. Lighthouse measured 330 ms of savings from this on
          the homepage; a preconnect costs one idle DNS+TLS handshake.

          - firebasestorage.googleapis.com serves every property image now
            that next/image points at Nubnb's own Storage rather than
            Vercel's optimiser. It is the LCP element's origin, so it is
            worth the handshake on every page.
          - basemaps.cartocdn.com is the map style and tiles. Only hinted,
            not preconnected: MapLibre is deliberately deferred past first
            paint (see DeferredMap), and opening a socket for it early would
            compete with the image that is actually on screen.

          No `crossOrigin` on the preconnect, deliberately: it would warm a
          CORS-mode connection, and `next/image` emits a plain <img> with no
          crossorigin attribute. The two use different connection pools, so
          the CORS variant warms a socket nothing then uses.

          Fonts are self-hosted by next/font, which emits its own correctly
          cross-origin preloads, so there is no font origin to warm here.
        */}
        <link rel="preconnect" href="https://firebasestorage.googleapis.com" />
        <link rel="dns-prefetch" href="https://basemaps.cartocdn.com" />
        <link rel="dns-prefetch" href="https://tiles.basemaps.cartocdn.com" />
      </head>
      <body className={`${manrope.variable} ${playfair.variable}`} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
