import type { Metadata, Viewport } from "next";
import { CleanerApp } from "./CleanerApp";

/**
 * /cleaner — where a cleaner logs what they bought for a property: their
 * four-digit code, the property, a photo of the receipt, the items, send.
 *
 * A static page with no data in it. Everything comes from /api/cleaner/*
 * behind the cleaner session cookie, which the browser sends to those routes
 * and nowhere else; nothing here reaches /admin or its API. Kept out of
 * search engines twice: `noindex` here, and a disallow in robots.ts.
 */

export const metadata: Metadata = {
  title: "Nubnb receipts",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function CleanerPage() {
  return <CleanerApp />;
}
