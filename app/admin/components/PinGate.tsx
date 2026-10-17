"use client";

/**
 * The admin's door (dispatch 38). Every admin page renders inside it.
 *
 * Kian's rulings of 2026-10-13: admins sign in with their PIN only — no name
 * is typed; the PIN identifies the admin — and five wrong PINs from one
 * connection lock sign-in from that connection for fifteen minutes (evening);
 * PINs are four digits, and twenty wrong PINs from one connection in a
 * Toronto day lock it until a main admin lifts it (late night). So the door
 * is four boxes, masked (PIN boxes mask their digits); four digits go by
 * themselves, an admin's PIN or the shared one.
 *
 * What it shows:
 *   - a wrong PIN: one line, and on the try before the lock, the warning;
 *   - a locked connection: the boxes greyed and "Locked until 4:32 pm",
 *     until then, in this browser's time; or, after the day's twenty, "Locked
 *     until a main admin lifts it";
 *   - Set your PIN, before anything else, to an admin whose PIN is not stored
 *     readably (Kian's rulings of 2026-10-13, night: PINs are stored readably;
 *     Nubnb no longer generates them): a main admin just signed in with the
 *     shared PIN, which is carried over as the current PIN; a session on a PIN
 *     kept before PINs were four digits is told who sets theirs instead;
 *   - a server that cannot check: says so, with Retry. Never the pages.
 *
 * The session itself is an HTTP-only cookie this page never sees: on mount it
 * asks the server who it is signed in as. A cookie that no longer opens
 * anything is answered "nobody" and cleared, and the door shows.
 *
 * Signed in, it gives its children the admin, through useAdminSession, for
 * the header's name, Change name, Change PIN and Sign out, and for the Admins
 * page's main-admin check (the server checks too: the page's check only
 * spares a refused request).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, Lock } from "lucide-react";
import styles from "./PinGate.module.css";
import { PinBoxes } from "./PinBoxes";
import { changeOwnPin, fetchSignedIn, isLockedAnswer, lockTimeWords, signIn, signOut } from "@/app/lib/admins-client";
import { PIN_LENGTH, SIGN_IN_PIN_PATTERN, isKeptBefore, isReadablePin, pinProblem, type SignedInAdminView } from "@/app/lib/admins/model";

// ─── The signed-in admin, for the pages ────────────────────────

export interface AdminSessionValue {
  admin: SignedInAdminView;
  /** Replace the admin as the page knows them (after Change PIN or Change name). */
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
  /** Signed in on a PIN not stored readably: their PIN first. `current`: the shared PIN just typed, when there is one. */
  | { kind: "set-pin"; admin: SignedInAdminView; current: string | null }
  | { kind: "in"; admin: SignedInAdminView };

/** Where a signed-in admin goes: in, or Set your PIN first. */
const landing = (admin: SignedInAdminView, current: string | null): Gate => (isReadablePin(admin.pin) ? { kind: "in", admin } : { kind: "set-pin", admin, current });

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
      if (result.ok) setGate(landing(result.data, null));
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

  if (gate.kind === "set-pin") {
    return <SetPin admin={gate.admin} current={gate.current} onSet={(admin) => setGate({ kind: "in", admin })} onSignOut={() => void doSignOut()} />;
  }

  return <SignIn onSignedIn={(admin, typed) => setGate(landing(admin, typed))} />;
}

// ─── Set your PIN ──────────────────────────────────────────────

/**
 * Before anything else, an admin whose PIN is not stored readably sets one:
 * the current PIN (the shared PIN just typed is carried over), then four digits
 * twice, in masked boxes. The PIN chosen is theirs; another admin's is
 * refused, and every try counts toward this connection's lock.
 */
function SetPin({ admin, current, onSet, onSignOut }: { admin: SignedInAdminView; current: string | null; onSet: (admin: SignedInAdminView) => void; onSignOut: () => void }) {
  if (isKeptBefore(admin.pin)) return <KeptBefore admin={admin} onSignOut={onSignOut} />;
  return <ChooseFour admin={admin} current={current} onSet={onSet} onSignOut={onSignOut} />;
}

/**
 * A session on a PIN kept before PINs were four digits (Kian's rulings of
 * 2026-10-13, late night): its holder does not set their own. A main admin
 * sets an ordinary admin's on the Admins page; a main admin goes through the
 * recovery script, then the shared PIN, then sets four digits here.
 */
function KeptBefore({ admin, onSignOut }: { admin: SignedInAdminView; onSignOut: () => void }) {
  return (
    <div className={styles.overlay}>
      <div className={styles.card} role="alert" aria-label="Set your PIN">
        <div className={styles.lockIcon}>
          <KeyRound size={24} />
        </div>
        <div className={styles.textGroup}>
          <h2 className={styles.title}>Your PIN is from before</h2>
          <p className={styles.subtitle}>
            {admin.level === "main"
              ? `${admin.name}, PINs are four digits now. Run the recovery script, then sign in with the shared PIN and set yours.`
              : `${admin.name}, PINs are four digits now. A main admin sets yours on the Admins page.`}
          </p>
        </div>
        <button type="button" className={styles.submitBtn} onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}

function ChooseFour({ admin, current, onSet, onSignOut }: { admin: SignedInAdminView; current: string | null; onSet: (admin: SignedInAdminView) => void; onSignOut: () => void }) {
  const [now, setNow] = useState(current ?? "");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const firstBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => firstBox.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  const ready = SIGN_IN_PIN_PATTERN.test(now) && next.length === PIN_LENGTH && again.length === PIN_LENGTH && !busy;

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
    const result = await changeOwnPin(now, next);
    setBusy(false);
    if (result.ok) return onSet(result.data);
    if (isLockedAnswer(result)) setError(`Too many tries: sign-in from here is locked until ${lockTimeWords(result.lockedUntil)}.`);
    else if (result.code === "ADMIN_CURRENT_PIN_WRONG") {
      setError(current ? "The shared PIN has changed: sign out, and sign in again." : "That is not your current PIN.");
      if (!current) setNow("");
    } else setError(result.unknown ? `${result.title} It may or may not have been set.` : result.title);
  };

  return (
    <div className={styles.overlay}>
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        aria-label="Set your PIN"
      >
        <div className={styles.lockIcon}>
          <KeyRound size={24} />
        </div>
        <div className={styles.textGroup}>
          <h2 className={styles.title}>Set your PIN</h2>
          <p className={styles.subtitle}>{admin.name}, choose the four digits you will sign in with</p>
        </div>
        {current === null && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Current PIN</span>
            <PinBoxes length={PIN_LENGTH} value={now} onChange={(v) => { setNow(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="Current PIN" compact firstRef={(el) => { firstBox.current = el; }} />
          </div>
        )}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>New PIN</span>
          <PinBoxes length={PIN_LENGTH} value={next} onChange={(v) => { setNext(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="New PIN" compact firstRef={current === null ? undefined : (el) => { firstBox.current = el; }} />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>New PIN again</span>
          <PinBoxes length={PIN_LENGTH} value={again} onChange={(v) => { setAgain(v); setError(null); }} onEnter={() => void save()} disabled={busy} label="New PIN again" compact />
        </div>
        {error && (
          <span className={styles.errorText} role="alert">
            {error}
          </span>
        )}
        <button type="submit" className={styles.submitBtn} disabled={!ready}>
          {busy ? "Saving…" : "Set PIN"}
        </button>
        <button type="button" className={styles.linkBtn} onClick={onSignOut} disabled={busy}>
          Sign out
        </button>
      </form>
    </div>
  );
}

// ─── Signing in ────────────────────────────────────────────────

function SignIn({ onSignedIn }: { onSignedIn: (admin: SignedInAdminView, typed: string) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  /** When sign-in from this connection is locked: until when (`until` null: until a main admin lifts it). */
  const [locked, setLocked] = useState<{ until: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const firstBox = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => firstBox.current?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // A fifteen-minute lock ends by itself: at its time the boxes come back. The day's cap waits for a main admin.
  useEffect(() => {
    if (!locked || locked.until === null) return;
    const timer = setTimeout(() => {
      setLocked(null);
      setError(null);
      setTimeout(() => firstBox.current?.focus(), 50);
    }, Math.max(0, Date.parse(locked.until) - Date.now()) + 500);
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
        onSignedIn(result.data, typed);
        return;
      }
      setPin("");
      if (isLockedAnswer(result)) {
        setLocked({ until: result.lockedUntil });
        setError({ title: result.lockedNow ? (result.lockedUntil === null ? "Twenty tries today." : "Five tries in a row.") : "Sign-in from here is locked." });
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
            {error?.title ? `${error.title} ` : ""}Locked until {lockTimeWords(locked.until)}.
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
