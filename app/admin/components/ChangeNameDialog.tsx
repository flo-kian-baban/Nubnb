"use client";

/**
 * Change name, from the admin's own menu (Kian's ruling of 2026-10-13,
 * evening: the admin can change their own name later; names stay unique).
 * The admin's history keeps the name before and after.
 */

import { useState } from "react";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import gate from "./PinGate.module.css";
import { changeOwnName } from "@/app/lib/admins-client";
import { ADMIN_NAME_MAX, adminNameProblem, type SignedInAdminView } from "@/app/lib/admins/model";

interface Props {
  admin: SignedInAdminView;
  onChanged: (admin: SignedInAdminView) => void;
  onClose: () => void;
}

export function ChangeNameDialog({ admin, onChanged, onClose }: Props) {
  const [name, setName] = useState(admin.name);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    const problem = adminNameProblem(name);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await changeOwnName(name);
    setBusy(false);
    if (result.ok) {
      onChanged(result.data.admin);
      onClose();
      return;
    }
    setError(result.unknown ? `${result.title} It may or may not have changed.` : result.title);
  };

  return (
    <Dialog
      title="Change name"
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="change-name" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy || name.trim() === ""}>
            {busy ? "Saving…" : "Save name"}
          </button>
        </>
      }
    >
      <form
        id="change-name"
        className={gate.pinForm}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <label className={gate.field}>
          <span className={gate.fieldLabel}>Name</span>
          <input className={gate.dialogInput} type="text" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} maxLength={ADMIN_NAME_MAX} autoComplete="off" spellCheck={false} disabled={busy} autoFocus />
        </label>
        {error && (
          <span className={gate.errorText} role="alert">
            {error}
          </span>
        )}
      </form>
    </Dialog>
  );
}
