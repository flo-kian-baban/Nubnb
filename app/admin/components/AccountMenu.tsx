"use client";

/**
 * The signed-in admin in the header (dispatch 38): their name, and a menu
 * with Change name, New PIN and Sign out (Kian's rulings of 2026-10-13,
 * evening: Change name beside the PIN; "New PIN" replaces the admin's PIN
 * with another random one, shown once). While the admin's PIN is not one
 * Nubnb generated — the shared PIN, or one chosen under dispatch 38's first
 * version — a dot on the name and the menu's first line say so: New PIN
 * replaces it.
 */

import { useEffect, useRef, useState } from "react";
import { ChevronDown, KeyRound, LogOut, UserPen } from "lucide-react";
import { ADMIN_LEVEL_LABELS, isGeneratedPin, type PinState } from "@/app/lib/admins/model";
import { useAdminSession } from "./PinGate";
import { ChangeNameDialog } from "./ChangeNameDialog";
import { NewPinDialog } from "./NewPinDialog";
import styles from "./AccountMenu.module.css";

/** A PIN that New PIN should replace, in words. */
const OLD_PIN_WORDS: Partial<Record<PinState, string>> = {
  shared: "shared PIN",
  own: "chosen PIN",
  temporary: "temporary PIN",
};

export function AccountMenu() {
  const session = useAdminSession();
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"name" | "pin" | null>(null);
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
  const oldPin = isGeneratedPin(admin.pin) ? null : (OLD_PIN_WORDS[admin.pin] ?? "PIN to replace");
  const pick = (which: "name" | "pin") => {
    setOpen(false);
    setDialog(which);
  };

  return (
    <div ref={rootRef} className={styles.root}>
      <button
        type="button"
        className={styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
        title={oldPin ? `Still on a ${oldPin}: New PIN replaces it` : undefined}
      >
        {oldPin && <span className={styles.dot} aria-hidden />}
        <span className={styles.name}>{admin.name}</span>
        <ChevronDown size={14} aria-hidden />
      </button>

      {open && (
        <div className={styles.menu} role="menu" aria-label={`${admin.name}'s account`}>
          <div className={styles.who}>
            <span className={styles.whoName}>{admin.name}</span>
            <span className={styles.whoLevel}>
              {ADMIN_LEVEL_LABELS[admin.level]}
              {oldPin ? ` · ${oldPin}` : ""}
            </span>
          </div>
          <button type="button" role="menuitem" className={styles.item} onClick={() => pick("name")}>
            <UserPen size={14} aria-hidden />
            <span>Change name</span>
          </button>
          <button type="button" role="menuitem" className={styles.item} onClick={() => pick("pin")}>
            <KeyRound size={14} aria-hidden />
            <span>New PIN</span>
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

      {dialog === "name" && <ChangeNameDialog admin={admin} onChanged={session.update} onClose={() => setDialog(null)} />}
      {dialog === "pin" && <NewPinDialog admin={admin} onRenewed={session.update} onClose={() => setDialog(null)} />}
    </div>
  );
}
