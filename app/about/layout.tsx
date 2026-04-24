import type { Metadata } from "next";
import type { ReactNode } from "react";
import AboutLayoutClient from "./AboutLayoutClient";

export const metadata: Metadata = {
  title: "About | NUBNB Suites — Premium Short-Term Rentals in the GTA",
  description:
    "Learn about NUBNB Suites — a locally managed short-term rental platform serving the Greater Toronto Area. Discover options for guests and property partners.",
  alternates: {
    canonical: "https://nubnb.ca/about",
  },
  openGraph: {
    title: "About | NUBNB Suites",
    description:
      "Discover premium short-term rentals and property management services across the Greater Toronto Area.",
    url: "https://nubnb.ca/about",
    siteName: "NUBNB Suites",
    type: "website",
    images: [{ url: "/logo-nubnb.png", width: 512, height: 512, alt: "NUBNB Suites" }],
  },
  twitter: {
    card: "summary",
    title: "About | NUBNB Suites",
    description:
      "Premium short-term rentals and property management in the GTA.",
    images: ["/logo-nubnb.png"],
  },
};

export default function AboutLayout({ children }: { children: ReactNode }) {
  return <AboutLayoutClient>{children}</AboutLayoutClient>;
}
