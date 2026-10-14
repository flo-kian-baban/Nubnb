"use client";

/**
 * The admin's door (dispatch 38). Every admin page renders inside it.
 *
 * Kian's rulings of 2026-10-13 (evening): admins sign in with their PIN only
 * — no name is typed; the PIN identifies the admin — and five wrong PINs from
 * one connection lock sign-in from that connection for fifteen minutes. So
 * the door is six boxes, masked (PIN boxes mask their digits). Six digits go
 * by themselves; the shared PIN, four digits today, goes with Sign in or
 * Enter.
 *
 * What it shows:
 *   - a wrong PIN: one line, and on the try before the lock, the warning;
 *   - a locked connection: the boxes greyed and "Locked until 4:32 pm",
 *     until then, in this browser's time;
 *   - the shared PIN, used by the main admin on it: the PIN Nubnb has just
 *     generated for them, shown this once, before anything else;
 *   - a server that cannot check: says so, with Retry. Never the pages.
 *
 * The session itself is an HTTP-only cookie this page never sees: on mount it
 * asks the server who it is signed in as. A cookie that no longer opens
 * anything is answered "nobody" and cleared, and the door shows.
 *
 * Signed in, it gives its children the admin, through useAdminSession, for
 * the header's name, Change name, New PIN and Sign out, and for the Admins
 * page's main-admin check (the server checks too: the page's check only
 * spares a refused request).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, Lock } from "lucide-react";
import styles from "./PinGate.module.css";
import { PinBoxes } from "./PinBoxes";
import { PinReveal } from "./PinReveal";
import { fetchSignedIn, lockTimeWords, signIn, signOut } from "@/app/lib/admins-client";
import { PIN_LENGTH, SIGN_IN_PIN_PATTERN, type SignedInAdminView } from "@/app/lib/admins/model";

// ─── The signed-in admin, for the pages ────────────────────────

export interface AdminSessionValue {
  admin: SignedInAdminView;
  /** Replace the admin as the page knows them (after New PIN or Change name). */
  update: (admin: SignedInAdminView) => void;
  signOut: () => Promise<void>;
}

const AdminSessionContext = createContext<AdminSessionValue | null>(null);

/** The signed-in admin; null outside the gate. */
export function useAdminSession(): AdminSessionValue | null {
  return useContext(AdminSessionContext);
}

// ─── The gate ──────────────────────────────────────────────────

type Gate =
  | { kind: "checking" }
  | { kind: "out" }
  | { kind: "unavailable"; title: string }
  /** Signed in with the shared PIN: the generated PIN to show once, then in. */
  | { kind: "reveal"; admin: SignedInAdminView; pin: string }
  | { kind: "in"; admin: SignedInAdminView };

interface PinGateProps {
  children: ReactNode;
}

export function PinGate({ children }: PinGateProps) {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    fetchSignedIn().then((result) => {
      if (cancelled) return;
      if (result.ok) setGate({ kind: "in", admin: result.data });
      else if (result.status === 401) setGate({ kind: "out" });
      else setGate({ kind: "unavailable", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const doSignOut = useCallback(async () => {
    await signOut();
    setGate({ kind: "out" });
  }, []);

  const update = useCallback((admin: SignedInAdminView) => setGate({ kind: "in", admin }), []);

  if (gate.kind === "checking") return null;

  if (gate.kind === "in") {
    return <AdminSessionContext.Provider value={{ admin: gate.admin, update, signOut: doSignOut }}>{children}</AdminSessionContext.Provider>;
  }

  if (gate.kind === "unavailable") {
    return (
      <div className={styles.overlay}>
        <div className={styles.card} role="alert">
          <div className={styles.lockIcon}>
            <Lock size={24} />
          </div>
          <div className={styles.textGroup}>
            <h2 className={styles.title}>Admin Access</h2>
            <p className={styles.subtitle}>{gate.title}</p>
          </div>
          <button type="button" className={styles.submitBtn} onClick={() => { setGate({ kind: "checking" }); setAttempt((n) => n + 1); }}>
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (gate.kind === "reveal") {
    const { admin, pin } = gate;
    return (
      <div className={styles.overlay}>
        <div className={styles.card} aria-label="Your new PIN">
          <div className={styles.lockIcon}>
            <KeyRound size={24} />
          </div>
          <div className={styles.textGroup}>
            <h2 className={styles.title}>Your new PIN</h2>
            <p className={styles.subtitle}>{admin.name}, sign in with this from now on</p>
          </div>
          <PinReveal pin={pin} label="Your new PIN" />
          <button type="button" className={styles.submitBtn} onClick={() => setGate({ kind: "in", admin })}>
            I have noted it
          </button>
        </div>
      </div>
    );
  }

  return <SignIn onSignedIn={(admin, newPin) => setGate(newPin ? { kind: "reveal", admin, pin: newPin } : { kind: "in", admin })} />;
}

// ─── Signing in ────────────────────────────────────────────────

function SignIn({ onSignedIn }: { onSignedIn: (admin: SignedInAdminView, newPin: string | null) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  /** When sign-in from this connection is locked: until when. */
  const [locked, setLocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => firstBox.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // The lock ends by itself: at its time the boxes come back.
  useEffect(() => {
    if (!locked) return;
    const timer = setTimeout(() => {
      setLocked(null);
      setError(null);
      setTimeout(() => firstBox.current?.focus(), 50);
    }, Math.max(0, Date.parse(locked) - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [locked]);

  const canSubmit = SIGN_IN_PIN_PATTERN.test(pin) && !busy && !locked;

  const submit = useCallback(
    async (typed: string) => {
      if (!SIGN_IN_PIN_PATTERN.test(typed) || busy || locked) return;
      setBusy(true);
      setError(null);
      const result = await signIn(typed);
      setBusy(false);
      if (result.ok) {
        onSignedIn(result.data.admin, result.data.newPin);
        return;
      }
      setPin("");
      if (result.status === 429 && result.lockedUntil) {
        setLocked(result.lockedUntil);
        setError({ title: result.lockedNow ? "Five wrong PINs." : "Sign-in from here is locked." });
        return;
      }
      // 401 is the only answer that means the PIN was wrong; anything else is said as it is.
      setError(result.status === 401 ? { title: "Wrong PIN.", hint: result.hint } : { title: result.title, hint: result.hint });
      setTimeout(() => firstBox.current?.focus(), 300);
    },
    [busy, locked, onSignedIn],
  );

  const onPin = (value: string) => {
    setPin(value);
    setError(null);
    if (value.length === PIN_LENGTH) void submit(value);
  };

  return (
    <div className={styles.overlay}>
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void submit(pin);
        }}
        aria-label="Admin sign-in"
      >
        <div className={`${styles.lockIcon} ${locked ? styles.lockIconLocked : ""}`}>
          <Lock size={24} />
        </div>

        <div className={styles.textGroup}>
          <h2 className={styles.title}>Admin Access</h2>
          <p className={styles.subtitle}>Your PIN</p>
        </div>

        <PinBoxes
          length={PIN_LENGTH}
          value={pin}
          onChange={onPin}
          onEnter={() => void submit(pin)}
          disabled={busy || locked !== null}
          invalid={error !== null && !locked}
          label="PIN"
          firstRef={(el) => {
            firstBox.current = el;
          }}
        />

        {locked ? (
          <span className={styles.lockedText} role="alert">
            {error?.title ? `${error.title} ` : ""}Locked until {lockTimeWords(locked)}.
          </span>
        ) : error ? (
          <span className={styles.errorText} role="alert">
            {error.title}
            {error.hint && <span className={styles.errorHint}>{error.hint}</span>}
          </span>
        ) : null}

        <button type="submit" className={styles.submitBtn} disabled={!canSubmit}>
          {busy ? "Checking…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
