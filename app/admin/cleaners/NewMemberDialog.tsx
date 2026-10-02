"use client";

/**
 * Adding a team member: a dialog opened from the header's "Add team member",
 * as Add Property opens its form. The role is chosen first, as two cards
 * that say what each role does, then the name, then the code: four digits
 * the admin types (Kian, dispatch 23H), or fills with "Generate" and keeps or
 * changes. The page makes the call: a refusal — the admin PIN, a code on the
 * reserved list, one already in use or used before — is shown here with
 * what was typed kept; a create closes the dialog and the page's notice
 * repeats the code.
 */

import { useEffect, useRef, type FormEvent } from "react";
import { Dices, Hammer, Receipt, X } from "lucide-react";
import { NoticeBanner, type Notice } from "../components/Notice";
import { CLEANER_ROLES, CLEANER_ROLE_LABELS, CODE_PATTERN, LIMITS, type CleanerRole } from "@/app/lib/cleaners/model";
import shared from "../page.module.css";
import styles from "./page.module.css";

const ROLE_DOES: Record<CleanerRole, string> = {
  cleaner: "Logs receipts",
  handyman: "Logs work and its price",
};

const ROLE_ICON = { cleaner: Receipt, handyman: Hammer } as const;

interface Props {
  name: string;
  role: CleanerRole;
  /** The code as typed so far: digits only, at most four. */
  code: string;
  creating: boolean;
  error: Notice | null;
  onName: (value: string) => void;
  onRole: (value: CleanerRole) => void;
  onCode: (value: string) => void;
  /** Fill the code field with a suggested code. */
  onGenerate: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClose: () => void;
}

export function NewMemberDialog({ name, role, code, creating, error, onName, onRole, onCode, onGenerate, onSubmit, onClose }: Props) {
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Escape closes, as Cancel does; never while a create is in flight.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creating) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [creating, onClose]);

  return (
    <div className={styles.overlay}>
      <form
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-member-title"
        onSubmit={onSubmit}
      >
        <div className={styles.dialogHead}>
          <h2 id="new-member-title" className={styles.dialogTitle}>
            New team member
          </h2>
          <button type="button" className={styles.dialogClose} onClick={onClose} disabled={creating} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>

        <div className={styles.dialogBody}>
          <fieldset className={styles.roleField} disabled={creating}>
            <legend className={styles.dialogLabel}>Role</legend>
            <div className={styles.roleCards}>
              {CLEANER_ROLES.map((value) => {
                const Icon = ROLE_ICON[value];
                return (
                  <label key={value} className={`${styles.roleCard} ${role === value ? styles.roleCardOn : ""}`}>
                    <input
                      type="radio"
                      name="new-member-role"
                      value={value}
                      checked={role === value}
                      onChange={() => onRole(value)}
                      className={styles.roleRadio}
                    />
                    <Icon size={18} aria-hidden className={styles.roleIcon} />
                    <span className={styles.roleName}>{CLEANER_ROLE_LABELS[value]}</span>
                    <span className={styles.roleDoes}>{ROLE_DOES[value]}</span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <div className={styles.nameField}>
            <label htmlFor="new-member-name" className={styles.dialogLabel}>
              Name
            </label>
            <input
              id="new-member-name"
              ref={nameRef}
              type="text"
              className={styles.nameInput}
              value={name}
              onChange={(e) => onName(e.target.value)}
              maxLength={LIMITS.NAME_MAX}
              autoComplete="off"
              spellCheck={false}
              disabled={creating}
            />
          </div>

          <div className={styles.nameField}>
            <label htmlFor="new-member-code" className={styles.dialogLabel}>
              Code
            </label>
            <div className={styles.codeEditorRow}>
              <input
                id="new-member-code"
                type="text"
                inputMode="numeric"
                pattern="[0-9]{4}"
                maxLength={4}
                className={styles.codeInput}
                value={code}
                onChange={(e) => onCode(e.target.value.replace(/\D/g, "").slice(0, 4))}
                autoComplete="off"
                spellCheck={false}
                disabled={creating}
              />
              <button type="button" className={styles.btnGhost} onClick={onGenerate} disabled={creating}>
                <Dices size={15} aria-hidden />
                <span>Generate</span>
              </button>
            </div>
          </div>

          <NoticeBanner notice={error} />
        </div>

        <div className={styles.dialogFoot}>
          <button type="button" className={shared.btnGhost} onClick={onClose} disabled={creating}>
            Cancel
          </button>
          <button type="submit" className={shared.btnPrimary} disabled={creating || name.trim() === "" || !CODE_PATTERN.test(code)}>
            {creating ? "Creating…" : `Create ${CLEANER_ROLE_LABELS[role].toLowerCase()}`}
          </button>
        </div>
      </form>
    </div>
  );
}
