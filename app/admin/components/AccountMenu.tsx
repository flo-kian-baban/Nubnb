"use client";

/**
 * The signed-in admin in the header (dispatch 38): their name, and a menu
 * with Change PIN and Sign out. While the main admin is still on today's
 * shared PIN (Kian's ruling: his until he changes it), a dot on the name and
 * the menu's first line say so.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, LogOut } from "lucide-react";
import { ADMIN_LEVEL_LABELS } from "@/app/lib/admins/model";
import { useAdminSession } from "./PinGate";
import { ChangePinDialog } from "./ChangePinDialog";
import styles from "./AccountMenu.module.css";

export function AccountMenu() {
  const session = useAdminSession();
  const [open, setOpen] = useState(false);
  const [changing, setChanging] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!session) return null;
  const { admin } = session;
  const shared = admin.pin === "shared";

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={shared ? "Still on the shared PIN" : undefined}
      >
        {shared && <span className={styles.dot} aria-hidden />}
        <span className={styles.name}>{admin.name}</span>
        <ChevronDown size={14} aria-hidden />
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={`${admin.name}'s account`}>
          <div className={styles.who}>
            <span className={styles.whoName}>{admin.name}</span>
            <span className={styles.whoLevel}>{ADMIN_LEVEL_LABELS[admin.level]}{shared ? " · shared PIN" : ""}</span>
          </div>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              setChanging(true);
            }}
          >
            <KeyRound size={14} aria-hidden />
            <span>Change PIN</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={styles.item}
            onClick={() => {
              setOpen(false);
              void session.signOut();
            }}
          >
            <LogOut size={14} aria-hidden />
            <span>Sign out</span>
          </button>
        </div>
      )}

      {changing && <ChangePinDialog admin={admin} onChanged={session.update} onClose={() => setChanging(false)} />}
    </div>
  );
}
