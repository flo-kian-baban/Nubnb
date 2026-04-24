import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "For Property Partners | Hands-Free Management in the GTA | NUBNB Suites",
  description:
    "Partner with NUBNB Suites for full-service property management in the Greater Toronto Area. Dynamic pricing, professional photography, guest screening, and monthly payouts — all handled for you.",
  alternates: {
    canonical: "https://nubnb.ca/about/partners",
  },
  openGraph: {
    title: "For Property Partners | NUBNB Suites",
    description:
      "Turn your GTA property into a professionally managed, income-generating asset. Full-service management with transparent monthly payouts.",
    url: "https://nubnb.ca/about/partners",
    siteName: "NUBNB Suites",
    type: "website",
    images: [{ url: "/logo-nubnb.png", width: 512, height: 512, alt: "NUBNB Suites — For Partners" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "For Property Partners | NUBNB Suites",
    description:
      "Hands-free property management in the GTA. Dynamic pricing, guest screening, and monthly payouts.",
    images: ["/logo-nubnb.png"],
  },
};

export default function PartnersLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
