"use client";

/**
 * A PIN typed into boxes, one digit each: the sign-in gate's look (dispatch
 * 38 made it shared, for the gate, choosing a PIN, and Change PIN). Digits
 * only; typing moves on, Backspace on an empty box goes back, a pasted PIN
 * fills the boxes from where it lands, and Enter asks the form to go ahead.
 * The value is the digits typed so far, never more than `length`.
 *
 * Kian's ruling of 2026-10-13: PIN boxes mask their digits. A filled box
 * shows a dot, never the digit, in every browser: the digits live in the
 * caller's state, and each box is given only the dot to show. A key typed
 * into a box is read from what the box then holds, the dot taken out.
 */

import { useEffect, useRef, type KeyboardEvent } from "react";
import styles from "./PinGate.module.css";

/** What a filled box shows instead of its digit. */
const MASK = "•";

interface Props {
  length: number;
  value: string;
  onChange: (value: string) => void;
  /** Enter in any box. */
  onEnter?: () => void;
  disabled?: boolean;
  invalid?: boolean;
  /** Read out for the group: "PIN", "New PIN". */
  label: string;
  /** Smaller boxes, for a dialog. */
  compact?: boolean;
  /** The first box, for a caller that puts the cursor in it. */
  firstRef?: (el: HTMLInputElement | null) => void;
}

export function PinBoxes({ length, value, onChange, onEnter, disabled, invalid, label, compact, firstRef }: Props) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? "");
  // The digits as typed so far, ahead of the next render: keys typed quickly arrive before `value` catches up, and
  // reading `value` then would drop them (or send the cursor back).
  const latest = useRef(value);
  useEffect(() => {
    latest.current = value;
  }, [value]);
  const set = (next: string) => {
    latest.current = next;
    onChange(next);
  };

  const focus = (i: number) => refs.current[Math.max(0, Math.min(length - 1, i))]?.focus();

  const change = (i: number, typed: string) => {
    const now = latest.current;
    const clean = typed.replace(/\D/g, "");
    if (clean === "") {
      // A cleared box: the PIN ends before it.
      set(now.slice(0, i));
      return;
    }
    // Digits land from this box on; a box after a gap is filled from the first empty one.
    const start = Math.min(i, now.length);
    const next = (now.slice(0, start) + clean).slice(0, length);
    set(next);
    focus(next.length);
  };

  const key = (i: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onEnter?.();
      return;
    }
    if (event.key === "Backspace" && !latest.current[i] && i > 0) {
      event.preventDefault();
      set(latest.current.slice(0, i - 1));
      focus(i - 1);
    }
  };

  return (
    <div className={`${styles.pinGroup} ${compact ? styles.pinGroupCompact : ""}`} role="group" aria-label={label}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
            if (i === 0) firstRef?.(el);
          }}
          type="text"
          inputMode="numeric"
          // Its dot and what is typed beside it, or a whole pasted PIN.
          maxLength={length + 1}
          value={digit ? MASK : ""}
          aria-label={`${label}, digit ${i + 1} of ${length}`}
          onChange={(e) => change(i, e.target.value)}
          onKeyDown={(e) => key(i, e)}
          onFocus={(e) => {
            // The cursor always goes to the first empty box, so the PIN is typed in order.
            if (i > latest.current.length) focus(latest.current.length);
            else e.target.select();
          }}
          className={`${styles.pinDigit} ${compact ? styles.pinDigitCompact : ""} ${digit ? styles.filled : ""} ${invalid ? styles.pinDigitError : ""}`}
          disabled={disabled}
          autoComplete="off"
        />
      ))}
    </div>
  );
}
