"use client";

/**
 * The admin's navigation, the same on every admin page: a column on the left (Kian's rulings of 2026-10-17, admin
 * home), grouped —
 *
 *   NUBNB  Admin
 *   OPERATIONS   Properties · Schedule · Availability
 *   MONEY        Costs · Income
 *   PEOPLE       Team · Leads · Admins
 *   ─────────
 *   Calendars read 09:14  [Refresh]
 *   [the admin's name ▾]
 *
 * It replaces the header across the top (2026-09-30), and with it the rule that its links took a row of their own
 * below 1400 px (Kian's ruling of 2026-10-13, evening).
 *
 * Below 1440 px wide the column shows icons only, each with its name on hover and focus; full labels at 1440 and up
 * (Kian's ruling of 2026-10-17, after his review). The names stay in the links as text, so a screen reader reads them
 * at every width; below 1440 they are drawn as a tooltip beside the icon. The brand becomes its initial, the tag its
 * time and a Refresh icon, the admin's name their initials (each whole in its tooltip).
 *
 * Navigation only (Kian's ruling of 2026-10-15): no link to the public site, and no page's own buttons — "Add
 * property", "Add team member" and the rest sit on the page they belong to (PageHead.tsx). The calendars' tag is the
 * one control here that is not a link: it is on every admin page by ruling, so it lives where every page has it.
 *
 * "Team" (dispatch 24) is the cleaners page, which holds handymen too. "Admins" (dispatch 38: the main admin adds and
 * removes admins and sets their level) is shown to a main admin only. The signed-in admin's name sits at the foot
 * (AccountMenu.tsx): Change name, Change PIN and Sign out, its menu opening upward.
 *
 * Built so a section can take sub-pages later: an item may carry `children`, shown under it, indented, while it or one
 * of them is the current page. None has any yet.
 *
 * The column is fixed to the window, so it stays in view however far a page scrolls (nothing in the admin can be
 * sticky: globals.css makes the body a scroll container). Each page's `.container` leaves its width free: 216 px at
 * 1440 and up, 72 px below. Below 900 px it becomes a block across the top of the page, with its labels.
 *
 * Section links do not prefetch: an admin taps one on purpose, and the admin pages are never warmed for nothing.
 */

import Link from "next/link";
import { Banknote, CalendarSearch, ClipboardCheck, Inbox, LayoutGrid, Receipt, ShieldCheck, Users } from "lucide-react";
import styles from "../page.module.css";
import { AccountMenu } from "./AccountMenu";
import { CalendarTag } from "./CalendarTag";
import { useAdminSession } from "./PinGate";

export type AdminSection = "properties" | "leads" | "costs" | "income" | "cleaners" | "availability" | "schedule" | "admins";

interface NavItem {
  key: AdminSection;
  label: string;
  href: string;
  Icon: typeof Inbox;
  /** Shown to a main admin only. */
  mainOnly?: boolean;
  /** Sub-pages, shown under the item while it or one of them is current. */
  children?: NavItem[];
}

const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operations",
    items: [
      { key: "properties", label: "Properties", href: "/admin", Icon: LayoutGrid },
      // The cleaning schedule (2026-10-14): each turnover's job, who is on it, and whether it is done.
      { key: "schedule", label: "Schedule", href: "/admin/schedule", Icon: ClipboardCheck },
      // Dispatch 22 (2026-09-30): the search for a caller's dates, and the attention list.
      { key: "availability", label: "Availability", href: "/admin/availability", Icon: CalendarSearch },
    ],
  },
  {
    label: "Money",
    items: [
      { key: "costs", label: "Costs", href: "/admin/costs", Icon: Receipt },
      // Dispatch 27 (2026-10-04): the platforms' files, the lines they propose, and each property's income for the month.
      { key: "income", label: "Income", href: "/admin/income", Icon: Banknote },
    ],
  },
  {
    label: "People",
    items: [
      { key: "cleaners", label: "Team", href: "/admin/cleaners", Icon: Users },
      { key: "leads", label: "Leads", href: "/admin/leads", Icon: Inbox },
      { key: "admins", label: "Admins", href: "/admin/admins", Icon: ShieldCheck, mainOnly: true },
    ],
  },
];

interface AdminHeaderProps {
  current: AdminSection;
  /** The page's heading for a screen reader, when it is not the section's name (a property's ledger). */
  title?: string;
}

const holds = (item: NavItem, key: AdminSection): boolean => item.key === key || (item.children ?? []).some((child) => holds(child, key));

function Item({ item, current }: { item: NavItem; current: AdminSection }) {
  const here = item.key === current;
  const open = holds(item, current);
  return (
    <li>
      <Link href={item.href} prefetch={false} className={`${styles.navItem} ${here ? styles.navItemCurrent : ""}`} aria-current={here ? "page" : undefined}>
        <item.Icon size={15} aria-hidden />
        <span className={styles.navLabel}>{item.label}</span>
      </Link>
      {open && item.children && item.children.length > 0 && (
        <ul className={styles.navSub}>
          {item.children.map((child) => (
            <Item key={child.key} item={child} current={current} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function AdminHeader({ current, title }: AdminHeaderProps) {
  const session = useAdminSession();
  const main = session?.admin.level === "main";
  const groups = GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => !item.mainOnly || main) })).filter((group) => group.items.length > 0);
  const heading = title ?? groups.flatMap((group) => group.items).find((item) => holds(item, current))?.label ?? "Admin";

  return (
    <aside className={styles.sideNav}>
      <Link href="/admin" prefetch={false} className={styles.brand} aria-label="Nubnb admin home">
        <span className={styles.brandWordmark}>NUBNB</span>
        <span className={styles.brandTag}>Admin</span>
        <span className={styles.brandMark} aria-hidden>
          N
        </span>
      </Link>

      <h1 className={styles.srOnly}>{heading}</h1>

      <nav className={styles.sideNavGroups} aria-label="Admin sections">
        {groups.map((group) => (
          <div key={group.label} className={styles.navGroup}>
            <p className={styles.navGroupLabel} id={`nav-${group.label.toLowerCase()}`}>
              {group.label}
            </p>
            <ul className={styles.navList} aria-labelledby={`nav-${group.label.toLowerCase()}`}>
              {group.items.map((item) => (
                <Item key={item.key} item={item} current={current} />
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <div className={styles.sideNavFoot}>
        <CalendarTag />
        <AccountMenu placement="up" />
      </div>
    </aside>
  );
}
