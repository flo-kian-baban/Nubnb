"use client";

/**
 * The property editor's controls (dispatch 30), every one Nubnb's own: no
 * native select, checkbox, date, month or file control, no browser bubble
 * and no browser dialog is shown on these pages (Kian's ruling of
 * 2026-10-10). Text is typed into plain inputs; numbers into text inputs
 * with a numeric keyboard; yes-or-no is a switch or a tick drawn here;
 * a question is asked in the dialog below.
 *
 * Every control that Save may point at carries `data-field`, the payload
 * path it edits (`addressDetails.city`), so the page can find it, open its
 * section and focus it.
 */

import { useEffect, useId, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type TextareaHTMLAttributes } from "react";
import { Check, X } from "lucide-react";
import styles from "./editor.module.css";

// ─── Field: a label over a control, the refusal under it, a note last ───

interface FieldProps {
  label: ReactNode;
  /** Beside the label at the right: the import's badge for this field. */
  badge?: ReactNode;
  /** What the server said, or what is missing, in red under the control. */
  issue?: ReactNode;
  /** One quiet line under the control. */
  hint?: ReactNode;
  /** Takes both columns of the grid. */
  wide?: boolean;
  /** The payload path, for a control that cannot carry `data-field` itself (a select, the photos): Save points at the field. */
  field?: string;
  className?: string;
  children: ReactNode;
}

export function Field({ label, badge, issue, hint, wide, field, className, children }: FieldProps) {
  return (
    <div className={`${styles.field} ${wide ? styles.span2 : ""} ${className ?? ""}`} data-field={field}>
      <div className={styles.fieldLabelRow}>
        <span className={styles.fieldLabel}>{label}</span>
        {badge}
      </div>
      {children}
      {issue && (
        <span className={styles.issue} role="alert" data-issue>
          {issue}
        </span>
      )}
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
}

// ─── Text ─────────────────────────────────────────────────────

interface TextInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "onChange" | "value" | "type"> {
  value: string;
  onChange: (value: string) => void;
  /** The payload path this edits. */
  field: string;
  invalid?: boolean;
  /** The import's class for this field: a green, amber or red tint on the border. */
  tint?: string;
}

export function TextInput({ value, onChange, field, invalid, tint, className, ...rest }: TextInputProps) {
  return (
    <input
      {...rest}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-field={field}
      aria-invalid={invalid || undefined}
      className={`${styles.input} ${invalid ? styles.inputInvalid : ""} ${tint ?? ""} ${className ?? ""}`}
      autoComplete="off"
    />
  );
}

interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "onChange" | "value"> {
  value: string;
  onChange: (value: string) => void;
  field: string;
  invalid?: boolean;
  tint?: string;
}

export function TextArea({ value, onChange, field, invalid, tint, className, ...rest }: TextAreaProps) {
  return (
    <textarea
      {...rest}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      data-field={field}
      aria-invalid={invalid || undefined}
      className={`${styles.input} ${styles.textarea} ${invalid ? styles.inputInvalid : ""} ${tint ?? ""} ${className ?? ""}`}
    />
  );
}

// ─── Number: a text field with a numeric keyboard, no spinner ──

interface NumberInputProps {
  value: number | undefined;
  onChange: (value: number) => void;
  field: string;
  /** Whole numbers only. */
  integer?: boolean;
  invalid?: boolean;
  tint?: string;
  placeholder?: string;
  disabled?: boolean;
  "aria-label"?: string;
  className?: string;
}

/**
 * Shown as typed while the field has focus (so "4." and "" can be typed
 * through); otherwise it shows the value. An empty or unfinished entry reads
 * as 0, as the dispatch-29 form read it.
 */
export function NumberInput({ value, onChange, field, integer, invalid, tint, placeholder, disabled, className, ...rest }: NumberInputProps) {
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? (value === undefined ? "" : String(value));
  const allowed = integer ? /^-?\d*$/ : /^-?\d*\.?\d*$/;
  return (
    <input
      type="text"
      inputMode={integer ? "numeric" : "decimal"}
      value={shown}
      placeholder={placeholder}
      disabled={disabled}
      aria-label={rest["aria-label"]}
      data-field={field}
      aria-invalid={invalid || undefined}
      className={`${styles.input} ${styles.number} ${invalid ? styles.inputInvalid : ""} ${tint ?? ""} ${className ?? ""}`}
      autoComplete="off"
      onFocus={() => setTyped(value === undefined ? "" : String(value))}
      onBlur={() => setTyped(null)}
      onChange={(e) => {
        const next = e.target.value.replace(/,/g, ".");
        if (!allowed.test(next)) return;
        setTyped(next);
        const parsed = integer ? parseInt(next, 10) : parseFloat(next);
        onChange(Number.isFinite(parsed) ? parsed : 0);
      }}
    />
  );
}

// ─── Switch: yes or no, with its name and one line ───────────

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description?: ReactNode;
  disabled?: boolean;
  field?: string;
  badge?: ReactNode;
  /** No frame of its own: the tile it sits in is the frame. */
  bare?: boolean;
}

export function Switch({ checked, onChange, label, description, disabled, field, badge, bare }: SwitchProps) {
  const id = useId();
  return (
    <div className={`${styles.switchRow} ${bare ? styles.switchBare : ""} ${disabled ? styles.switchRowDisabled : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-name`}
        aria-describedby={description ? `${id}-desc` : undefined}
        disabled={disabled}
        data-field={field}
        className={`${styles.switch} ${checked ? styles.switchOn : ""}`}
        onClick={() => onChange(!checked)}
      >
        <span className={styles.switchKnob} aria-hidden />
      </button>
      <span className={styles.switchText} onClick={() => !disabled && onChange(!checked)}>
        <span id={`${id}-name`} className={styles.switchName}>
          {label}
          {badge}
        </span>
        {description && (
          <span id={`${id}-desc`} className={styles.switchDesc}>
            {description}
          </span>
        )}
      </span>
    </div>
  );
}

// ─── Tick: a small checkbox drawn here ───────────────────────

interface TickProps {
  checked: boolean;
  onChange: () => void;
  label: string;
  title?: string;
  disabled?: boolean;
}

export function Tick({ checked, onChange, label, title, disabled }: TickProps) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      title={title}
      disabled={disabled}
      className={`${styles.tick} ${checked ? styles.tickOn : ""}`}
      onClick={onChange}
    >
      {checked && <Check size={12} strokeWidth={3} aria-hidden />}
    </button>
  );
}

// ─── Dialog: the one way a question is asked on these pages ──

interface DialogProps {
  title: string;
  children: ReactNode;
  /** The buttons, the primary last. */
  actions: ReactNode;
  /** Escape, and the × in the corner. */
  onClose: () => void;
  /** Where the keyboard goes when it opens: a button of the foot, or "none" when a field in the body takes it (dispatch 34). */
  initialFocus?: "first" | "last" | "none";
  /** A list to work through rather than a question (dispatch 36): wider, and its body scrolls. */
  wide?: boolean;
}

export function Dialog({ title, children, actions, onClose, initialFocus = "first", wide = false }: DialogProps) {
  const id = useId();
  const footRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (initialFocus === "none") return;
    const buttons = footRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? [];
    const target = initialFocus === "last" ? buttons[buttons.length - 1] : buttons[0];
    target?.focus();
  }, [initialFocus]);

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // The keyboard stays in the dialog.
  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input, textarea, [tabindex]:not([tabindex='-1'])"));
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={styles.overlay} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`${styles.dialog} ${wide ? styles.dialogWide : ""}`} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} onKeyDown={trap}>
        <div className={styles.dialogHead}>
          <h2 id={`${id}-title`} className={styles.dialogTitle}>
            {title}
          </h2>
          <button type="button" className={styles.dialogClose} onClick={onClose} aria-label="Close">
            <X size={16} aria-hidden />
          </button>
        </div>
        <div id={`${id}-body`} className={styles.dialogBody}>
          {children}
        </div>
        <div ref={footRef} className={styles.dialogFoot}>
          {actions}
        </div>
      </div>
    </div>
  );
}

// ─── A small inline notice with one action (the restored-changes bar) ───

export function ActionBar({ children, actionLabel, onAction, onDismiss }: { children: ReactNode; actionLabel: string; onAction: () => void; onDismiss: () => void }) {
  return (
    <div className={styles.actionBar} role="status">
      <span className={styles.actionBarText}>{children}</span>
      <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} onClick={onAction}>
        {actionLabel}
      </button>
      <button type="button" className={styles.actionBarClose} onClick={onDismiss} aria-label="Dismiss">
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
