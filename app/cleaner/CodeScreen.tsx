"use client";

/**
 * The code screen: four boxes and the number pad, nothing else.
 *
 * One real input sits over the four boxes, so typing, deleting and pasting
 * behave as in any field; the boxes only show the digits. The fourth digit
 * sends the code. A code that does not open the door clears the boxes and
 * says so in three words; the input keeps its focus, so the keyboard stays up
 * for the next try.
 *
 * The cleaner door's lock (Kian's ruling of 2026-10-14, evening): the wrong
 * code before a lock says what the next one does, and a locked connection says
 * until when — or that the office lifts it — and takes no code until then.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { SignInResult } from "@/app/lib/cleaner-client";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";

const CODE_LENGTH = 4;

type CodeState = { kind: "idle" } | { kind: "checking" } | Exclude<SignInResult, { kind: "ok" }>;

/** "19:45", Toronto. */
const clock = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

/** What the screen says under the boxes, and a second line when there is one. */
function messageOf(state: CodeState): [string, string | null] | null {
  switch (state.kind) {
    case "not-recognised":
      return ["Code not recognised", state.warning];
    case "locked":
      return state.until === null ? ["Too many wrong codes today", "Ask the office to unlock sign-in."] : ["Too many wrong codes", `Try again at ${clock(state.until)}.`];
    case "offline":
      return ["No connection. Try again.", null];
    case "failed":
      return ["Something went wrong. Try again.", null];
    default:
      return null;
  }
}

export function CodeScreen({ onCode }: { onCode: (code: string) => Promise<SignInResult> }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<CodeState>({ kind: "idle" });
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Android opens the keyboard at once; an iPhone waits for a tap on the boxes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A lock that ends opens the boxes again by itself.
  useEffect(() => {
    if (state.kind !== "locked" || state.until === null) return;
    const wait = Date.parse(state.until) - Date.now();
    const timer = window.setTimeout(() => setState({ kind: "idle" }), Math.max(0, wait) + 1_000);
    return () => window.clearTimeout(timer);
  }, [state]);

  const locked = state.kind === "locked";

  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    if (state.kind === "checking" || locked) return;
    const digits = event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setValue(digits);
    setState({ kind: "idle" });
    if (digits.length < CODE_LENGTH) return;

    setState({ kind: "checking" });
    const result = await onCode(digits);
    if (result.kind === "ok") return;
    setValue("");
    setState(result);
  };

  const message = messageOf(state);
  const wrong = state.kind === "not-recognised" || locked;

  return (
    <>
      <CleanerBar />
      <main className={styles.codeScreen}>
        <label className={`${styles.codeBoxes} ${wrong ? styles.codeBoxesWrong : ""}`}>
          {Array.from({ length: CODE_LENGTH }, (_, i) => (
            <span
              key={i}
              aria-hidden
              className={`${styles.codeBox} ${focused && !locked && i === Math.min(value.length, CODE_LENGTH - 1) ? styles.codeBoxActive : ""} ${state.kind === "checking" ? styles.codeBoxChecking : ""}`}
            >
              {value[i] ?? ""}
            </span>
          ))}
          <input
            ref={inputRef}
            className={styles.codeInput}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
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
        </label>
        <p className={styles.codeMessage} role="alert">
          {message ? message[0] : ""}
          {message?.[1] && <span className={styles.codeHint}>{message[1]}</span>}
        </p>
      </main>
    </>
  );
}
