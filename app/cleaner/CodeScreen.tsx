"use client";

/**
 * The code screen: four boxes and the number pad, nothing else.
 *
 * One real input sits over the four boxes, so typing, deleting and pasting
 * behave as in any field; the boxes only show the digits. The fourth digit
 * sends the code. A code that does not open the door clears the boxes and
 * says so in three words; the input keeps its focus, so the keyboard stays up
 * for the next try.
 */

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { SignInResult } from "@/app/lib/cleaner-client";
import styles from "./cleaner.module.css";

const CODE_LENGTH = 4;

type CodeState = "idle" | "checking" | SignInResult["kind"];

const MESSAGES: Partial<Record<CodeState, string>> = {
  "not-recognised": "Code not recognised",
  offline: "No connection. Try again.",
  failed: "Something went wrong. Try again.",
};

export function CodeScreen({ onCode }: { onCode: (code: string) => Promise<SignInResult["kind"]> }) {
  const [value, setValue] = useState("");
  const [state, setState] = useState<CodeState>("idle");
  const [focused, setFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Android opens the keyboard at once; an iPhone waits for a tap on the boxes.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const change = async (event: ChangeEvent<HTMLInputElement>) => {
    if (state === "checking") return;
    const digits = event.target.value.replace(/\D/g, "").slice(0, CODE_LENGTH);
    setValue(digits);
    setState("idle");
    if (digits.length < CODE_LENGTH) return;

    setState("checking");
    const result = await onCode(digits);
    if (result === "ok") return;
    setValue("");
    setState(result);
  };

  const message = MESSAGES[state];

  return (
    <main className={styles.codeScreen}>
      <label className={`${styles.codeBoxes} ${state === "not-recognised" ? styles.codeBoxesWrong : ""}`}>
        {Array.from({ length: CODE_LENGTH }, (_, i) => (
          <span
            key={i}
            aria-hidden
            className={`${styles.codeBox} ${focused && i === Math.min(value.length, CODE_LENGTH - 1) ? styles.codeBoxActive : ""} ${state === "checking" ? styles.codeBoxChecking : ""}`}
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
          aria-invalid={state === "not-recognised"}
          value={value}
          onChange={change}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
        />
      </label>
      <p className={styles.codeMessage} role="alert">
        {message ?? ""}
      </p>
    </main>
  );
}
