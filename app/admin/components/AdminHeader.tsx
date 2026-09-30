"use client";

/**
 * The one admin header (2026-09-30), the same on every admin page:
 *
 *   NUBNB  Admin   Properties · Leads · Costs · Cleaners · Availability   View Site ↗  [page action]
 *
 * Before this each page built its own: "Properties" was the title on one
 * page and a back link on the other three, "View Site" sat where a back
 * button goes, Leads had no link at all, and the property page mixed two
 * section links with its Add button in one cluster. Now navigation is on
 * the left, always in the same order, with the current section marked (and
 * read out as the page's heading); what the page itself can do is on the
 * right, its primary action last.
 *
 * It follows the public site's own nav (app/about/page.tsx): the NUBNB
 * wordmark (without the logo mark, at Kian's request), quiet 13 px links,
 * and a white pill for the one call to action. Every control is 36 px tall and pill-shaped; the styles
 * are in ../page.module.css, which every admin page shares.
 *
 * Section links do not prefetch: an admin taps one on purpose, and the
 * admin pages are never warmed for nothing (the same reason the property
 * rows stopped prefetching).
 */

import Link from "next/link";
import type { ReactNode } from "react";
import { CalendarSearch, ExternalLink, Inbox, LayoutGrid, Receipt, Users } from "lucide-react";
import styles from "../page.module.css";

export type AdminSection = "properties" | "leads" | "costs" | "cleaners" | "availability";

const SECTIONS: { key: AdminSection; label: string; href: string; Icon: typeof Inbox }[] = [
  { key: "properties", label: "Properties", href: "/admin", Icon: LayoutGrid },
  { key: "leads", label: "Leads", href: "/admin/leads", Icon: Inbox },
  { key: "costs", label: "Costs", href: "/admin/costs", Icon: Receipt },
  { key: "cleaners", label: "Cleaners", href: "/admin/cleaners", Icon: Users },
  // Dispatch 22 (2026-09-30): the search for a caller's dates, and the attention list.
  { key: "availability", label: "Availability", href: "/admin/availability", Icon: CalendarSearch },
];

interface AdminHeaderProps {
  current: AdminSection;
  /** The page's heading for a screen reader, when it is not the section's name (a property's ledger). */
  title?: string;
  /** The page's own actions, primary last. */
  children?: ReactNode;
}

export function AdminHeader({ current, title, children }: AdminHeaderProps) {
  const heading = title ?? SECTIONS.find((section) => section.key === current)?.label ?? "Admin";

  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/admin" prefetch={false} className={styles.brand} aria-label="Nubnb admin home">
          <span className={styles.brandWordmark}>NUBNB</span>
          <span className={styles.brandTag}>Admin</span>
        </Link>

        <h1 className={styles.srOnly}>{heading}</h1>

        <nav className={styles.sectionNav} aria-label="Admin sections">
          {SECTIONS.map(({ key, label, href, Icon }) => (
            <Link
              key={key}
              href={href}
              prefetch={false}
              className={`${styles.navItem} ${key === current ? styles.navItemCurrent : ""}`}
              aria-current={key === current ? "page" : undefined}
            >
              <Icon size={15} aria-hidden />
              <span>{label}</span>
            </Link>
          ))}
        </nav>

        <div className={styles.headerActions}>
          <a href="/" target="_blank" rel="noopener" className={styles.viewSite}>
            <span>View Site</span>
            <ExternalLink size={13} aria-hidden />
          </a>
          {children}
        </div>
      </div>
    </header>
  );
}
