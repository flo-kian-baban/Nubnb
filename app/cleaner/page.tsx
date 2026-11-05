import type { Metadata, Viewport } from "next";
import { CleanerApp } from "./CleanerApp";

/**
 * /cleaner — a cleaner's app: their four-digit code, then their jobs for
 * today and tomorrow, and a receipt for what they bought: the camera, then
 * the property, the items and the tax on one screen, send. A handyman logs
 * work here the same way.
 *
 * A static page with no data in it. Everything comes from /api/cleaner/*
 * behind the cleaner session cookie, which the browser sends to those routes
 * and nowhere else; nothing here reaches /admin or its API. Kept out of
 * search engines twice: `noindex` here, and a disallow in robots.ts.
 *
 * The phone's own detection of addresses, dates, phone numbers and emails is off here (2026-11-05): on an iPhone it
 * drew a dotted underline under a job's address, which opens nothing in this app. The styles also flatten any link
 * Safari still adds (cleaner.module.css).
 */

export const metadata: Metadata = {
  title: "Nubnb receipts",
  robots: { index: false, follow: false },
  formatDetection: { telephone: false, date: false, address: false, email: false },
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function CleanerPage() {
  return <CleanerApp />;
}
