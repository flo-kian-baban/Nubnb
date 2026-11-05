"use client";

/**
 * The bar at the top of every screen: white with a hairline under it, and the NUBNB wordmark as the public site's
 * header sets it (Kian's ruling of 2026-10-17) — the logo mark at 28 pixels beside "NUBNB" in bold, tracked capitals,
 * in the site's dark navy, the app staying light. On a step into the flow it carries Back and, on a receipt, nothing
 * else.
 *
 * On the home and History (Kian's instruction of 2026-11-05, after his test on an iPhone) it carries the person's first
 * name with a small chevron at the right, "Kian ▾": a tap opens a small menu with Sign out, which asks once — "Sign
 * out? You'll need your code to sign in again." — and, under the bar, two tabs across the full width with the current
 * one underlined: a cleaner's "Jobs | History", a handyman's "Add work | My work". No pill and nothing at the page's
 * foot. Styles in cleaner.module.css (".bar…", ".name…", ".menu…", ".tab…").
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import Image from "next/image";
import { ChevronDown, ChevronLeft, LogOut } from "lucide-react";
import { firstNameOf } from "@/app/lib/cleaner-home";
import styles from "./cleaner.module.css";
import { AskDialog } from "./AskDialog";

/** Who is signed in, for the name menu: their name as the office gave it, and Sign out. */
export interface BarPerson {
  name: string | null;
  onSignOut: () => void;
  signingOut: boolean;
}

/** One of the two tabs under the bar. */
export interface BarTab {
  label: string;
  current: boolean;
  onSelect: () => void;
}

interface CleanerBarProps {
  /** Back, when the screen is a step into the flow; the wordmark otherwise. */
  onBack?: () => void;
  backDisabled?: boolean;
  /** The property's name on a step, at the right. */
  title?: string;
  /** The name menu at the right, on the home and History. */
  person?: BarPerson;
  /** The two tabs under the bar, on the home and History. */
  tabs?: readonly BarTab[];
}

/** "Kian ▾": the first name and a chevron; under it, a small menu with Sign out, which asks once. */
function NameMenu({ person }: { person: BarPerson }) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  const label = firstNameOf(person.name) ?? "Account";
  const stopAsking = useCallback(() => setAsking(false), []);

  // A tap anywhere else closes the menu; Escape closes it and gives the focus back to the name.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={boxRef} className={styles.nameMenu}>
      <button ref={buttonRef} type="button" className={`${styles.nameButton} ${open ? styles.nameButtonOpen : ""}`} aria-expanded={open} aria-controls={menuId} onClick={() => setOpen((was) => !was)}>
        <span className={styles.nameText}>{label}</span>
        <span className={styles.visuallyHidden}>, account</span>
        <ChevronDown aria-hidden />
      </button>
      <div id={menuId} className={styles.menu} hidden={!open}>
        <button
          type="button"
          className={styles.menuItem}
          onClick={() => {
            setOpen(false);
            setAsking(true);
          }}
        >
          <LogOut aria-hidden />
          <span>Sign out</span>
        </button>
      </div>
      {asking && <AskDialog title="Sign out?" words="You’ll need your code to sign in again." confirmLabel="Sign out" busyLabel="Signing out…" busy={person.signingOut} onConfirm={person.onSignOut} onCancel={stopAsking} />}
    </div>
  );
}

/** The two tabs under the bar, full width; the current one underlined and in the ink. */
function Tabs({ tabs }: { tabs: readonly BarTab[] }) {
  return (
    <nav className={styles.tabs} aria-label="Screens">
      {tabs.map((tab) => (
        <button key={tab.label} type="button" className={`${styles.tab} ${tab.current ? styles.tabCurrent : ""}`} aria-current={tab.current ? "page" : undefined} onClick={tab.onSelect}>
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export function CleanerBar({ onBack, backDisabled, title, person, tabs }: CleanerBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.barInner}>
        {onBack ? (
          <button type="button" className={styles.barBack} onClick={onBack} disabled={backDisabled}>
            <ChevronLeft aria-hidden />
            <span>Back</span>
          </button>
        ) : (
          <p className={styles.barBrand}>
            <Image src="/logo-nubnb.png" alt="" width={28} height={28} priority className={styles.barLogo} />
            <span className={styles.barWordmark}>NUBNB</span>
          </p>
        )}
        {title ? <p className={styles.barTitle}>{title}</p> : person ? <NameMenu person={person} /> : null}
      </div>
      {tabs && tabs.length > 0 && <Tabs tabs={tabs} />}
    </header>
  );
}
