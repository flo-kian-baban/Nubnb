/**
 * A section page's head (Kian's ruling of 2026-10-15: the navigation bar holds no page's own buttons; each sits on the
 * page it belongs to): the page's name on the left, and what the page itself can do on the right, its primary action
 * last. Pages with a head of their own — a property's page, the property editor, a person's pay — put their buttons
 * in it instead.
 */

import type { ReactNode } from "react";
import styles from "../page.module.css";

export function PageHead({ title, children, className }: { title: string; children?: ReactNode; className?: string }) {
  return (
    <div className={`${styles.pageHead} ${className ?? ""}`}>
      <h2 className={styles.pageTitle}>{title}</h2>
      {children && <div className={styles.pageActions}>{children}</div>}
    </div>
  );
}
