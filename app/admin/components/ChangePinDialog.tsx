"use client";

/**
 * Change PIN, from the admin's own menu (Kian's rulings of 2026-10-13: an
 * admin can still change their own PIN; PINs stay unique (night); four
 * digits, never a cleaner code current or retired (late night)).
 * The current PIN first, then the new one twice, all in masked boxes (PIN
 * boxes mask their digits). A wrong current PIN counts toward this
 * connection's lock, and so does every change: a PIN refused because another
 * admin holds it tells the chooser that admin's PIN. A refusal says why in one
 * plain line (Kian's ruling of 2026-10-17): another admin's PIN, a cleaner
 * code, too easy. Every other session the admin holds ends; this one carries
 * on with a new cookie.
 */

import { useEffect, useRef, useState } from "react";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import gate from "./PinGate.module.css";
import { PinBoxes } from "./PinBoxes";
import { changeOwnPin, isLockedAnswer, lockTimeWords } from "@/app/lib/admins-client";
import { PIN_LENGTH, SIGN_IN_PIN_PATTERN, pinProblem, type SignedInAdminView } from "@/app/lib/admins/model";

interface Props {
  admin: SignedInAdminView;
  onChanged: (admin: SignedInAdminView) => void;
  onClose: () => void;
}

export function ChangePinDialog({ admin, onChanged, onClose }: Props) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const firstBox = useRef<HTMLInputElement | null>(null);

  // The cursor starts in the current PIN's first box, once.
  useEffect(() => {
    const timer = setTimeout(() => firstBox.current?.focus(), 50);
    return () => clearTimeout(timer);
  }, []);

  const ready = SIGN_IN_PIN_PATTERN.test(current) && next.length === PIN_LENGTH && again.length === PIN_LENGTH && !busy;

  const save = async () => {
    if (!ready) return;
    if (next !== again) {
      setError("The two new PINs differ.");
      setAgain("");
      return;
    }
    const problem = pinProblem(next);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await changeOwnPin(current, next);
    setBusy(false);
    if (result.ok) {
      setDone(true);
      onChanged(result.data);
      return;
    }
    // The server's warning before the try that locks, which names the lock: fifteen minutes, or until lifted.
    const lastTry = result.hint?.match(/One more [^.]*\./)?.[0];
    if (isLockedAnswer(result)) setError(`Too many tries: sign-in from here is locked until ${lockTimeWords(result.lockedUntil)}.`);
    else if (result.code === "ADMIN_CURRENT_PIN_WRONG") {
      setError(lastTry ? `That is not your current PIN. ${lastTry}` : "That is not your current PIN.");
      setCurrent("");
      // Another admin's PIN, or a cleaner code: the server's one line says which (Kian's ruling of 2026-10-17).
    } else if (result.code === "ADMIN_PIN_TAKEN" || result.code === "ADMIN_PIN_IS_A_CODE") setError(lastTry ? `${result.title} ${lastTry}` : result.title);
    else setError(result.unknown ? `${result.title} It may or may not have changed.` : result.title);
  };

  if (done) {
    return (
      <Dialog
        title="PIN changed"
        onClose={onClose}
        actions={
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={onClose}>
            Done
          </button>
        }
      >
        <p>Use your new PIN from now on. Any other device signed in as {admin.name} is signed out.</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      title="Change your PIN"
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="change-pin" className={`${ed.btn} ${ed.btnPrimary}`} disabled={!ready}>
            {busy ? "Saving…" : "Save PIN"}
          </button>
        </>
      }
    >
      <form
        id="change-pin"
        className={gate.pinForm}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className={gate.field}>
          <span className={gate.fieldLabel}>{admin.pin === "shared" ? "Current PIN (the shared one)" : "Current PIN"}</span>
          <PinBoxes length={PIN_LENGTH} value={current} onChange={(v) => { setCurrent(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="Current PIN" compact firstRef={(el) => { firstBox.current = el; }} />
        </div>
        <div className={gate.field}>
          <span className={gate.fieldLabel}>New PIN</span>
          <PinBoxes length={PIN_LENGTH} value={next} onChange={(v) => { setNext(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="New PIN" compact />
        </div>
        <div className={gate.field}>
          <span className={gate.fieldLabel}>Again</span>
          <PinBoxes length={PIN_LENGTH} value={again} onChange={(v) => { setAgain(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="New PIN again" compact />
        </div>
        {error && (
          <span className={gate.errorText} role="alert">
            {error}
          </span>
        )}
      </form>
    </Dialog>
  );
}
