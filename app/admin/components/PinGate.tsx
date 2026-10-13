"use client";

/**
 * The admin's door (dispatch 38). Every admin page renders inside it.
 *
 * Kian's rulings of 2026-10-13: each admin signs in with their own PIN, and
 * five wrong tries lock that PIN for fifteen minutes. So the door asks whose
 * PIN it is — a name, remembered on this device after a sign-in, so on their
 * own devices an admin types only the PIN — and the PIN, in six boxes. Today's
 * shared PIN is four digits and stays the main admin's until he changes it,
 * so four digits go too, with Sign in or Enter; six go by themselves.
 *
 * What it shows:
 *   - a wrong name or PIN: one line, and on the try before the lock, the
 *     warning that the next wrong one locks it;
 *   - a locked PIN: the boxes greyed and "Locked until 4:32 pm", until then;
 *     the time is this browser's. Another name can still be typed;
 *   - a temporary PIN (an admin the main admin added, or gave a new PIN):
 *     "Choose your PIN" before anything else, the only step it opens;
 *   - a server that cannot check: says so, with Retry. Never the pages.
 *
 * The session itself is an HTTP-only cookie this page never sees: on mount it
 * asks the server who it is signed in as. A cookie from before dispatch 38 is
 * answered "nobody" and cleared, and the door shows.
 *
 * Signed in, it gives its children the admin, through useAdminSession, for
 * the header's name, Change PIN and Sign out, and for the Admins page's
 * main-admin check (the server checks too: the page's check only spares a
 * refused request).
 */

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyRound, Lock } from "lucide-react";
import styles from "./PinGate.module.css";
import { PinBoxes } from "./PinBoxes";
import { changeOwnPin, fetchSignedIn, lockTimeWords, signIn, signOut } from "@/app/lib/admins-client";
import { PIN_LENGTH, SIGN_IN_PIN_PATTERN, newPinProblem, type SignedInAdminView } from "@/app/lib/admins/model";

/** Where this device remembers the last name that signed in. A convenience: it may come back empty. */
const NAME_KEY = "nubnb.admin.name";

function rememberedName(): string {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function rememberName(name: string): void {
  try {
    window.localStorage.setItem(NAME_KEY, name);
  } catch {
    /* a private window: the name is typed next time */
  }
}

// ─── The signed-in admin, for the pages ────────────────────────

export interface AdminSessionValue {
  admin: SignedInAdminView;
  /** Replace the admin as the page knows them (after Change PIN). */
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
  /** `temporaryPin`: the one just typed at sign-in, so it is not asked twice. Never stored. */
  | { kind: "choose"; admin: SignedInAdminView; temporaryPin: string | null }
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
      if (result.ok) setGate(result.data.pin === "temporary" ? { kind: "choose", admin: result.data, temporaryPin: null } : { kind: "in", admin: result.data });
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

  if (gate.kind === "choose") {
    return (
      <ChoosePin
        admin={gate.admin}
        temporaryPin={gate.temporaryPin}
        onChosen={(admin) => setGate({ kind: "in", admin })}
        onSignedOut={() => setGate({ kind: "out" })}
      />
    );
  }

  return (
    <SignIn
      onSignedIn={(admin, pin) => setGate(admin.pin === "temporary" ? { kind: "choose", admin, temporaryPin: pin } : { kind: "in", admin })}
    />
  );
}

// ─── Signing in ────────────────────────────────────────────────

function SignIn({ onSignedIn }: { onSignedIn: (admin: SignedInAdminView, pin: string) => void }) {
  // The name this device signed in with last. The gate renders this only in the browser, after its check.
  const [name, setName] = useState(rememberedName);
  const [pin, setPin] = useState("");
  const [error, setError] = useState<{ title: string; hint?: string } | null>(null);
  const [locked, setLocked] = useState<{ name: string; until: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const firstBox = useRef<HTMLInputElement | null>(null);

  // The cursor where the next thing is typed: the PIN when the name is known.
  useEffect(() => {
    const timer = setTimeout(() => (rememberedName() ? firstBox.current : nameRef.current)?.focus(), 100);
    return () => clearTimeout(timer);
  }, []);

  // The lock ends by itself: at its time the boxes come back.
  useEffect(() => {
    if (!locked) return;
    const wait = Date.parse(locked.until) - Date.now();
    const timer = setTimeout(() => {
      setLocked(null);
      setError(null);
      setTimeout(() => firstBox.current?.focus(), 50);
    }, Math.max(0, wait) + 500);
    return () => clearTimeout(timer);
  }, [locked]);

  const lockedNow = locked !== null && locked.name === name.trim();
  const canSubmit = name.trim() !== "" && SIGN_IN_PIN_PATTERN.test(pin) && !busy && !lockedNow;

  const submit = useCallback(
    async (typed: string) => {
      if (name.trim() === "" || !SIGN_IN_PIN_PATTERN.test(typed) || busy || lockedNow) return;
      setBusy(true);
      setError(null);
      const result = await signIn(name.trim(), typed);
      setBusy(false);
      if (result.ok) {
        rememberName(name.trim());
        onSignedIn(result.data, typed);
        return;
      }
      setPin("");
      if (result.status === 429 && result.lockedUntil) {
        setLocked({ name: name.trim(), until: result.lockedUntil });
        setError({ title: result.lockedNow ? "Five wrong tries." : "This PIN is locked." });
        return;
      }
      // 401 is the only answer that means the name or PIN was wrong; anything else is said as it is.
      setError(result.status === 401 ? { title: "Wrong name or PIN.", hint: result.hint } : { title: result.title });
      setTimeout(() => firstBox.current?.focus(), 300);
    },
    [busy, lockedNow, name, onSignedIn],
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
        <div className={`${styles.lockIcon} ${lockedNow ? styles.lockIconLocked : ""}`}>
          <Lock size={24} />
        </div>

        <div className={styles.textGroup}>
          <h2 className={styles.title}>Admin Access</h2>
          <p className={styles.subtitle}>Your name and PIN</p>
        </div>

        <input
          ref={nameRef}
          className={styles.nameInput}
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="Name"
          aria-label="Name"
          autoComplete="username"
          autoCapitalize="words"
          spellCheck={false}
          maxLength={60}
          disabled={busy}
        />

        <PinBoxes
          length={PIN_LENGTH}
          value={pin}
          onChange={onPin}
          onEnter={() => void submit(pin)}
          disabled={busy || lockedNow}
          invalid={error !== null && !lockedNow}
          label="PIN"
          firstRef={(el) => {
            firstBox.current = el;
          }}
        />

        {lockedNow ? (
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

// ─── Choosing one's own PIN ────────────────────────────────────

function ChoosePin({
  admin,
  temporaryPin,
  onChosen,
  onSignedOut,
}: {
  admin: SignedInAdminView;
  temporaryPin: string | null;
  onChosen: (admin: SignedInAdminView) => void;
  onSignedOut: () => void;
}) {
  const [current, setCurrent] = useState(temporaryPin ?? "");
  const [askCurrent, setAskCurrent] = useState(temporaryPin === null);
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = isSixDigits(current) && next.length === PIN_LENGTH && again.length === PIN_LENGTH && !busy && locked === null;

  const save = async () => {
    if (!ready) return;
    if (next !== again) {
      setError("The two PINs differ.");
      setAgain("");
      return;
    }
    const problem = newPinProblem(next);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await changeOwnPin(current, next);
    setBusy(false);
    if (result.ok) {
      onChosen(result.data);
      return;
    }
    if (result.code === "ADMIN_SESSION_INVALID") {
      onSignedOut();
      return;
    }
    if (result.status === 429 && result.lockedUntil) {
      setLocked(result.lockedUntil);
      return;
    }
    if (result.code === "ADMIN_CURRENT_PIN_WRONG") {
      setAskCurrent(true);
      setCurrent("");
      setError(result.hint?.startsWith("One more") ? "That is not your temporary PIN. One more wrong try locks it for 15 minutes." : "That is not your temporary PIN.");
      return;
    }
    setError(result.title);
  };

  return (
    <div className={styles.overlay}>
      <form
        className={styles.card}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        aria-label="Choose your PIN"
      >
        <div className={styles.lockIcon}>
          <KeyRound size={24} />
        </div>

        <div className={styles.textGroup}>
          <h2 className={styles.title}>Choose your PIN</h2>
          <p className={styles.subtitle}>{admin.name}, six digits only you know</p>
        </div>

        {askCurrent && (
          <div className={styles.field}>
            <span className={styles.fieldLabel}>Temporary PIN</span>
            <PinBoxes length={PIN_LENGTH} value={current} onChange={(v) => { setCurrent(v); setError(null); }} disabled={busy || locked !== null} label="Temporary PIN" compact />
          </div>
        )}
        <div className={styles.field}>
          <span className={styles.fieldLabel}>New PIN</span>
          <PinBoxes length={PIN_LENGTH} value={next} onChange={(v) => { setNext(v); setError(null); }} disabled={busy || locked !== null} label="New PIN" compact />
        </div>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Again</span>
          <PinBoxes length={PIN_LENGTH} value={again} onChange={(v) => { setAgain(v); setError(null); }} onEnter={() => void save()} disabled={busy || locked !== null} label="New PIN again" compact />
        </div>

        {locked ? (
          <span className={styles.lockedText} role="alert">Locked until {lockTimeWords(locked)}.</span>
        ) : error ? (
          <span className={styles.errorText} role="alert">{error}</span>
        ) : null}

        <button type="submit" className={styles.submitBtn} disabled={!ready}>
          {busy ? "Saving…" : "Save PIN"}
        </button>
      </form>
    </div>
  );
}

/** The temporary PIN as typed: six digits (one the main admin set). */
function isSixDigits(pin: string): boolean {
  return pin.length === PIN_LENGTH && /^[0-9]+$/.test(pin);
}
