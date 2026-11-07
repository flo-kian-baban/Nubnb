"use client";

/**
 * The code screen: one line saying what to do, the four boxes, and a number pad under them; nothing else.
 *
 * The line reads "Enter your 4-digit code"; after a session ends — Sign out, a new code, the account deactivated — it
 * reads "Signed out. Enter your code." (Kian's ruling of 2026-11-02, Build 1, item 5).
 *
 * The number pad, for Kian's ruling of 2026-11-06: "when the code screen opens, the numbers must be there to tap, on
 * every phone" (an iPhone never opens its keyboard as a page loads). Three across, 1–9, then 0 and Delete, there from
 * the first moment, on opening and after a sign-out. Each digit fills the next box, the fourth sends the code, and
 * Delete takes the last digit off. A code that does not open the door clears the boxes and says so in three words; the
 * pad stays. The phone's own keyboard never opens here, so no phone shows two pads: the one real input is hidden, no
 * tap reaches it, and it asks for no keyboard (inputmode none). It stays for screen readers and a keyboard; what is
 * typed or pasted into it goes the way the pad's digits go. On arrival the line takes the focus (2026-11-06: no box to
 * type in takes focus by itself).
 *
 * The cleaner door's lock (Kian's ruling of 2026-10-14, evening): the wrong code before a lock says what the next one
 * does, and a locked connection says until when — or that the office lifts it, or, after the day's budget of wrong
 * codes was spent (Kian's ruling of 2026-11-06), until tomorrow — and takes no code until then: the pad waits.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Delete } from "lucide-react";
import type { SignInResult } from "@/app/lib/cleaner-client";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";

const CODE_LENGTH = 4;
/** The pad's first three rows; its last is a blank, 0 and Delete. */
const PAD_DIGITS = ["1", "2", "3", "4", "5", "6", "7", "8", "9"] as const;

type CodeState = { kind: "idle" } | { kind: "checking" } | Exclude<SignInResult, { kind: "ok" }>;

/** "19:45", Toronto. */
const clock = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** What the screen says under the boxes, and a second line when there is one. */
function messageOf(state: CodeState): [string, string | null] | null {
  switch (state.kind) {
    case "not-recognised":
      return ["Code not recognised", state.warning];
    case "locked":
      if (state.until === null) return ["Too many wrong codes today", "Ask the office to unlock sign-in."];
      // The day's budget was spent and one wrong code locked this connection until tomorrow (Kian's ruling of 2026-11-06).
      if (state.budget) return ["Locked until tomorrow", "Many wrong codes today. The office can unlock sign-in sooner."];
      return ["Too many wrong codes", `Try again at ${clock(state.until)}.`];
    case "offline":
      return ["No connection. Try again.", null];
    case "failed":
      return ["Something went wrong. Try again.", null];
    default:
      return null;
  }
}

export function CodeScreen({ onCode, signedOut = false }: { onCode: (code: string) => Promise<SignInResult>; /** A session just ended: the line says so. */ signedOut?: boolean }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<CodeState>({ kind: "idle" });
  /** The hidden input has the focus (a keyboard, a screen reader): the boxes show it. */
  const [focused, setFocused] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  /** The digits as they stand, for taps quicker than a render. */
  const valueRef = useRef("");

  // The line takes the focus on arrival, so a screen reader starts there, after a sign-out too; nothing to type in
  // takes it.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // A lock that ends opens the pad again by itself. The wait is capped at what setTimeout can hold (about 24.8 days): a
  // day lock seen from a phone whose clock lags would otherwise overflow into "now".
  useEffect(() => {
    if (state.kind !== "locked" || state.until === null) return;
    const wait = Math.min(Math.max(0, Date.parse(state.until) - Date.now()) + 1_000, 2_147_483_647);
    const timer = window.setTimeout(() => setState({ kind: "idle" }), wait);
    return () => window.clearTimeout(timer);
  }, [state]);

  const locked = state.kind === "locked";
  const checking = state.kind === "checking";
  /** The pad takes a digit: not while a code is checked, not while sign-in is locked. */
  const ready = !locked && !checking;

  const show = (digits: string) => {
    valueRef.current = digits;
    setValue(digits);
  };

  /** The digits as they now stand, from the pad or the hidden input: the fourth sends the code. */
  const enter = async (typed: string) => {
    if (!ready) return;
    const digits = typed.replace(/\D/g, "").slice(0, CODE_LENGTH);
    show(digits);
    setState({ kind: "idle" });
    if (digits.length < CODE_LENGTH) return;

    setState({ kind: "checking" });
    const result = await onCode(digits);
    if (result.kind === "ok") return;
    show("");
    setState(result);
  };

  /** The hidden input: typing, deleting and pasting, from a keyboard or a screen reader. */
  const change = (event: ChangeEvent<HTMLInputElement>) => void enter(event.target.value);
  /** A digit on the pad, into the next box. */
  const press = (digit: string) => void enter(valueRef.current + digit);
  /** Delete: the last digit off. */
  const erase = () => {
    if (valueRef.current !== "") void enter(valueRef.current.slice(0, -1));
  };

  const message = messageOf(state);
  const wrong = state.kind === "not-recognised" || locked;
  /** The box the next digit goes in, lit while the pad takes one. */
  const next = ready ? Math.min(value.length, CODE_LENGTH - 1) : -1;

  return (
    <>
      <CleanerBar />
      <main className={styles.codeScreen}>
        <h1 ref={titleRef} tabIndex={-1} className={styles.codeTitle}>
          {signedOut ? "Signed out. Enter your code." : "Enter your 4-digit code"}
        </h1>
        <div className={`${styles.codeBoxes} ${wrong ? styles.codeBoxesWrong : ""} ${focused ? styles.codeBoxesFocused : ""}`} aria-hidden>
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <span key={i} className={`${styles.codeBox} ${i === next ? styles.codeBoxActive : ""} ${checking ? styles.codeBoxChecking : ""}`}>
              {value[i] ?? ""}
            </span>
          ))}
        </div>
        {/* The one real input: hidden, out of reach of a tap, and asking for no keyboard; for screen readers and a keyboard. */}
        <input
          className={styles.visuallyHidden}
          type="text"
          inputMode="none"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          maxLength={CODE_LENGTH}
          aria-label="Your code"
          aria-invalid={wrong}
          disabled={locked}
          value={value}
          onChange={change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
        <p className={styles.codeMessage} role="alert">
          {message ? message[0] : ""}
          {message?.[1] && <span className={styles.codeHint}>{message[1]}</span>}
        </p>
        <div className={styles.codePad} role="group" aria-label="Number pad">
          {PAD_DIGITS.map((digit) => (
            <button key={digit} type="button" className={`${styles.light} ${styles.codeKey}`} onClick={() => press(digit)} disabled={!ready}>
              {digit}
            </button>
          ))}
          <span aria-hidden />
          <button type="button" className={`${styles.light} ${styles.codeKey}`} onClick={() => press("0")} disabled={!ready}>
            0
          </button>
          <button type="button" className={`${styles.light} ${styles.codeKey}`} onClick={erase} disabled={!ready} aria-label="Delete">
            <Delete aria-hidden />
          </button>
        </div>
      </main>
    </>
  );
}
