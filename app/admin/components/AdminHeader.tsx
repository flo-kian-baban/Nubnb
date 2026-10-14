"use client";

/**
 * The one admin header (2026-09-30), the same on every admin page:
 *
 *   NUBNB  Admin   Properties · Leads · Costs · Income · Team · Availability   View Site ↗  [page action]
 *
 * "Team" (dispatch 24) is the cleaners page, which now holds handymen too.
 * "Income" (dispatch 27, Kian's ruling of 2026-10-04) sits beside Costs: the
 * one place income comes in for all properties.
 * "Admins" (dispatch 38, Kian's ruling of 2026-10-13: the main admin adds
 * and removes admins and sets their level) is shown to a main admin only, last.
 * The signed-in admin's name sits before View Site (AccountMenu.tsx): Change
 * name, Change PIN and Sign out.
 *
 * Kian's ruling of 2026-10-13 (evening): below 1400 px wide, the section links
 * sit on their own row under the brand and the actions, on every admin page
 * (page.module.css). Wider, they take their own row too whenever the brand,
 * the links and the actions do not fit on one: a long name, or a page with
 * several actions, would otherwise run the links under the actions. The
 * header measures that itself: the links' own widths, which do not change
 * with the layout, against the room the row has. Nothing is ever cut off or
 * scrolled sideways at desktop widths.
 * "Reports" (dispatch 23B) was a section from 2026-09-30 to dispatch 23F
 * (2026-10-01): the statements are written on each property's page now, and
 * the cross-property view is a panel on the admin home, under the
 * Statements tile.
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
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Banknote, CalendarSearch, ExternalLink, Inbox, LayoutGrid, Receipt, ShieldCheck, Users } from "lucide-react";
import styles from "../page.module.css";
import { AccountMenu } from "./AccountMenu";
import { useAdminSession } from "./PinGate";

export type AdminSection = "properties" | "leads" | "costs" | "income" | "cleaners" | "availability" | "admins";

const SECTIONS: { key: AdminSection; label: string; href: string; Icon: typeof Inbox }[] = [
  { key: "properties", label: "Properties", href: "/admin", Icon: LayoutGrid },
  { key: "leads", label: "Leads", href: "/admin/leads", Icon: Inbox },
  { key: "costs", label: "Costs", href: "/admin/costs", Icon: Receipt },
  // Dispatch 27 (2026-10-04): the platforms' files, the lines they propose, and each property's income for the month.
  { key: "income", label: "Income", href: "/admin/income", Icon: Banknote },
  { key: "cleaners", label: "Team", href: "/admin/cleaners", Icon: Users },
  // Dispatch 22 (2026-09-30): the search for a caller's dates, and the attention list.
  { key: "availability", label: "Availability", href: "/admin/availability", Icon: CalendarSearch },
];

/** Dispatch 38: a main admin's section, after the others. */
const ADMINS_SECTION = { key: "admins" as const, label: "Admins", href: "/admin/admins", Icon: ShieldCheck };

interface AdminHeaderProps {
  current: AdminSection;
  /** The page's heading for a screen reader, when it is not the section's name (a property's ledger). */
  title?: string;
  /** The page's own actions, primary last. */
  children?: ReactNode;
}

/** Whether the brand, the section links and the actions need more than one row's room. */
function crowdedRow(inner: HTMLElement, brand: HTMLElement, nav: HTMLElement, actions: HTMLElement): boolean {
  const row = getComputedStyle(inner);
  const gap = parseFloat(row.columnGap) || 0;
  const room = inner.clientWidth - (parseFloat(row.paddingLeft) || 0) - (parseFloat(row.paddingRight) || 0);
  const links = Array.from(nav.children);
  const linkGap = parseFloat(getComputedStyle(nav).columnGap) || 0;
  const linksWidth = links.reduce((sum, link) => sum + link.getBoundingClientRect().width, 0) + linkGap * Math.max(0, links.length - 1);
  return brand.getBoundingClientRect().width + gap + linksWidth + gap + actions.getBoundingClientRect().width > room + 0.5;
}

export function AdminHeader({ current, title, children }: AdminHeaderProps) {
  const session = useAdminSession();
  const sections = session?.admin.level === "main" ? [...SECTIONS, ADMINS_SECTION] : SECTIONS;
  const heading = title ?? sections.find((section) => section.key === current)?.label ?? "Admin";
  const innerRef = useRef<HTMLDivElement>(null);
  const brandRef = useRef<HTMLAnchorElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const [stacked, setStacked] = useState(false);

  // Before the first paint and on every change of width (the window, the name, the page's actions): one row or two.
  useLayoutEffect(() => {
    const [inner, brand, nav, actions] = [innerRef.current, brandRef.current, navRef.current, actionsRef.current];
    if (!inner || !brand || !nav || !actions) return;
    const measure = () => setStacked(crowdedRow(inner, brand, nav, actions));
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [inner, brand, actions, ...Array.from(nav.children)]) observer.observe(element);
    return () => observer.disconnect();
  }, [sections.length]);

  return (
    <header className={`${styles.header} ${stacked ? styles.headerStacked : ""}`}>
      <div ref={innerRef} className={styles.headerInner}>
        <Link ref={brandRef} href="/admin" prefetch={false} className={styles.brand} aria-label="Nubnb admin home">
          <span className={styles.brandWordmark}>NUBNB</span>
          <span className={styles.brandTag}>Admin</span>
        </Link>

        <h1 className={styles.srOnly}>{heading}</h1>

        <nav ref={navRef} className={styles.sectionNav} aria-label="Admin sections">
          {sections.map(({ key, label, href, Icon }) => (
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

        <div ref={actionsRef} className={styles.headerActions}>
          <AccountMenu />
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
