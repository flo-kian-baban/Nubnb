"use client";

/**
 * The admin's single feedback mechanism.
 *
 * Before this, failures were reported four different ways: `alert()` in one
 * image handler, `console.error` in another, an inline green/red bar in the
 * form, and nothing at all for list loads and deletes. Everything that the
 * operator needs to know now goes through `useNotice` + `<NoticeBanner>`.
 */

import { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import styles from "./Notice.module.css";

export type NoticeTone = "error" | "warning" | "success" | "info";

export interface Notice {
  tone: NoticeTone;
  /** One line. What happened, in the operator's terms. */
  title: string;
  /** Optional second line: why, or what to do next. */
  detail?: string;
  /** Optional bullets — field-level issues, per-field warnings. */
  items?: string[];
}

const ICONS = {
  error: XCircle,
  warning: AlertTriangle,
  success: CheckCircle2,
  info: Info,
} as const;

const TONE_CLASS: Record<NoticeTone, string> = {
  error: styles.error,
  warning: styles.warning,
  success: styles.success,
  info: styles.info,
};

export function NoticeBanner({
  notice,
  onDismiss,
  className,
}: {
  notice: Notice | null;
  onDismiss?: () => void;
  className?: string;
}) {
  if (!notice) return null;
  const Icon = ICONS[notice.tone];

  return (
    <div
      className={`${styles.banner} ${TONE_CLASS[notice.tone]} ${className || ""}`}
      role={notice.tone === "error" ? "alert" : "status"}
    >
      <Icon size={16} className={styles.icon} aria-hidden />
      <div className={styles.body}>
        <span className={styles.title}>{notice.title}</span>
        {notice.detail && <span className={styles.detail}>{notice.detail}</span>}
        {notice.items && notice.items.length > 0 && (
          <ul className={styles.items}>
            {notice.items.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        )}
      </div>
      {onDismiss && (
        <button type="button" className={styles.dismiss} onClick={onDismiss} aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

/** One notice slot. The newest message replaces the previous one. */
export function useNotice(): {
  notice: Notice | null;
  show: (notice: Notice) => void;
  clear: () => void;
} {
  const [notice, setNotice] = useState<Notice | null>(null);
  const show = useCallback((next: Notice) => setNotice(next), []);
  const clear = useCallback(() => setNotice(null), []);
  return { notice, show, clear };
}
