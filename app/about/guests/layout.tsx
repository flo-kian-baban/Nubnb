import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "For Guests | Premium Short-Term Rentals in the GTA | NUBNB Suites",
  description:
    "Browse curated short-term rental properties across the Greater Toronto Area. Verified listings, transparent pricing, and responsive local hosts. Book your next stay with NUBNB Suites.",
  alternates: {
    canonical: "https://nubnb.ca/about/guests",
  },
  openGraph: {
    title: "For Guests | NUBNB Suites",
    description:
      "Discover premium short-term rentals across Toronto, Markham, Vaughan, and the GTA. Verified properties with transparent pricing.",
    url: "https://nubnb.ca/about/guests",
    siteName: "NUBNB Suites",
    type: "website",
    images: [{ url: "/logo-nubnb.png", width: 512, height: 512, alt: "NUBNB Suites — For Guests" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "For Guests | NUBNB Suites",
    description:
      "Curated short-term rentals in the GTA. Verified properties, transparent pricing, local hosts.",
    images: ["/logo-nubnb.png"],
  },
};

export default function GuestsLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
