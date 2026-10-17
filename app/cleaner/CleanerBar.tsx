"use client";

/**
 * The bar at the top of every screen: white with a hairline under it, and the NUBNB wordmark as the public site's
 * header sets it (Kian's ruling of 2026-10-17) — the logo mark at 28 pixels beside "NUBNB" in bold, tracked capitals,
 * in the site's dark navy, the app staying light. On the home screen it carries History; on a step into the flow it
 * carries Back and, on a receipt, nothing else. Styles in cleaner.module.css (".bar…").
 */

import type { ReactNode } from "react";
import Image from "next/image";
import { ChevronLeft } from "lucide-react";
import styles from "./cleaner.module.css";

interface CleanerBarProps {
  /** Back, when the screen is a step into the flow; the wordmark otherwise. */
  onBack?: () => void;
  backDisabled?: boolean;
  /** The property's name on a step, at the right. */
  title?: string;
  /** Buttons at the right, on the home screen. */
  actions?: ReactNode;
}

export function CleanerBar({ onBack, backDisabled, title, actions }: CleanerBarProps) {
  return (
    <header className={styles.bar}>
      <div className={styles.barInner}>
        {onBack ? (
          <button type="button" className={styles.barBack} onClick={onBack} disabled={backDisabled}>
            <ChevronLeft aria-hidden />
            <span>Back</span>
          </button>
        ) : (
          <p className={styles.barBrand}>
            <Image src="/logo-nubnb.png" alt="" width={28} height={28} priority className={styles.barLogo} />
            <span className={styles.barWordmark}>NUBNB</span>
          </p>
        )}
        {title ? <p className={styles.barTitle}>{title}</p> : actions ? <div className={styles.barActions}>{actions}</div> : null}
      </div>
    </header>
  );
}
