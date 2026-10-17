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
