import type { Metadata } from "next";
import { Manrope, Playfair_Display } from "next/font/google";
import "./globals.css";
import { Providers } from "./components/Providers";

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
      <body className={`${manrope.variable} ${playfair.variable}`} suppressHydrationWarning>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
