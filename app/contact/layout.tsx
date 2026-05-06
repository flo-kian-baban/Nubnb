import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Contact | NUBNB Suites | Get in Touch",
  description:
    "Reach out to the NuBnb Suites team. Whether you're looking to book a stay or list your property, we're here to help.",
  alternates: {
    canonical: "https://nubnb.ca/contact",
  },
  openGraph: {
    title: "Contact | NUBNB Suites",
    description:
      "Get in touch with the NuBnb Suites team for bookings, partnerships, or general enquiries.",
    url: "https://nubnb.ca/contact",
    siteName: "NUBNB Suites",
    type: "website",
    images: [{ url: "/logo-nubnb.png", width: 512, height: 512, alt: "NUBNB Suites" }],
  },
  twitter: {
    card: "summary",
    title: "Contact | NUBNB Suites",
    description: "Get in touch with the NuBnb Suites team.",
    images: ["/logo-nubnb.png"],
  },
};

export default function ContactLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
