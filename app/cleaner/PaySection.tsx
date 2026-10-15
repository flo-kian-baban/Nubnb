"use client";

/**
 * A team member's own pay in their app (Team pay, Kian's ruling 6 of 2026-10-15): their Earned, Paid and Balance, and
 * nobody else's — the start call sends only theirs, worked out by the same function the Team page uses
 * (app/lib/pay/balance.ts). Three figures, no list: the office keeps the list. Under a cleaner's jobs; at the top of a
 * handyman's screen.
 *
 * A balance above zero is owed to them; below zero they were overpaid (ruling 3), in the warning tone. Items listed
 * but not counted yet are said in one line; an entry that cannot be added up is said too, so a figure is never taken
 * for whole when it is not.
 */

import { formatCents, type CleanerStart } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";

export function PaySection({ pay }: { pay: CleanerStart["pay"] }) {
  const balance = pay.balanceCents > 0 ? `${formatCents(pay.balanceCents)} owed to you` : pay.balanceCents < 0 ? `Overpaid ${formatCents(-pay.balanceCents)}` : "All paid";
  return (
    <section aria-labelledby="pay-heading" className={styles.pay}>
      <h2 id="pay-heading" className={styles.sectionLabel}>
        Your pay
      </h2>
      <dl className={styles.payFigures}>
        <div className={styles.payFigure}>
          <dt>Earned</dt>
          <dd>{formatCents(pay.earnedCents)}</dd>
        </div>
        <div className={styles.payFigure}>
          <dt>Paid</dt>
          <dd>{formatCents(pay.paidCents)}</dd>
        </div>
        <div className={`${styles.payFigure} ${pay.balanceCents < 0 ? styles.payOverpaid : ""}`}>
          <dt>Balance</dt>
          <dd>{balance}</dd>
        </div>
      </dl>
      {pay.waiting > 0 && <p className={styles.payNote}>{pay.waiting === 1 ? "1 item is" : `${pay.waiting} items are`} waiting for review or an amount: not counted yet.</p>}
      {pay.cannotAddUp > 0 && <p className={styles.payNote}>{pay.cannotAddUp === 1 ? "1 item" : `${pay.cannotAddUp} items`} could not be added up and {pay.cannotAddUp === 1 ? "is" : "are"} left out. Ask the office.</p>}
    </section>
  );
}
