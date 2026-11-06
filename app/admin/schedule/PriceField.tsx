"use client";

/**
 * The Schedule's price control (the Add a job pass, Kian's instruction of 2026-11-06): one amount field, the property's
 * other cleaning prices one tap away beside it ("Mid $Y", "Long $Z", only where it has them), and one line under it.
 * The caller holds the tier and the amount, and says what the line reads. With no price for the tier, the field is empty
 * and the amount last typed there is its grey placeholder, never its value (Build 2: nothing is saved untyped).
 *
 * Two uses (the same day): Add a job, where a tap picks the tier the price came from; and the price in Assign and
 * Change cleaner (`fixedTier`), where the job's tier stays its own and every cleaning price of the unit that differs
 * from the field is one tap away, the job's own tier's included. `locked`: read-only, no taps (the job's money counts).
 */

import { TIER_NIGHTS, TIER_WORDS, priceField, type CleaningPrices, type PresetKind } from "@/app/lib/cleanings/prices";
import { readAmountCents } from "@/app/lib/cleanings/model";
import { priceChips, tierField, type LastTyped } from "@/app/lib/schedule/add-job";
import styles from "./page.module.css";

/** Where the prices stand: nothing to price yet, being read, read, or not readable. */
export type PriceState = "none" | "loading" | "ready" | "error";

export function PriceField(props: {
  /** For the line's id (the field is described by it). */
  id: string;
  label: string;
  state: PriceState;
  prices: CleaningPrices | null;
  lastTyped: LastTyped;
  tier: PresetKind;
  amount: string;
  onChange: (next: { tier: PresetKind; amount: string }) => void;
  /** The line under the field. */
  words: string;
  /** The placeholder while there is nothing to price yet. */
  emptyPlaceholder?: string;
  disabled?: boolean;
  /** The job's tier stays its own: the taps fill the amount from any of the unit's cleaning prices (Assign, Change cleaner). */
  fixedTier?: boolean;
  /** Read-only, no taps: the job's money already counts. */
  locked?: boolean;
}) {
  const { id, label, state, prices, lastTyped, tier, amount, onChange, words, emptyPlaceholder, disabled, fixedTier, locked } = props;
  const cents = amount.trim() === "" ? null : readAmountCents(amount);
  const choices = state !== "ready" || locked ? [] : priceChips(prices, tier, cents, fixedTier === true);
  const placeholder = state === "ready" ? tierField(prices, lastTyped, tier).placeholder : state === "none" ? (emptyPlaceholder ?? "") : "";
  return (
    <>
      <div className={styles.amountRow}>
        <input
          className={`${styles.amountInput} ${styles.priceInput} ${locked ? styles.priceLocked : ""}`}
          inputMode="decimal"
          value={amount}
          placeholder={placeholder}
          onChange={(e) => onChange({ tier, amount: e.target.value })}
          readOnly={locked}
          disabled={disabled || state === "none" || state === "loading"}
          aria-label={label}
          aria-describedby={`${id}-words`}
        />
        {choices.map((choice) => (
          <button key={choice.tier} type="button" className={styles.choice} onClick={() => onChange({ tier: fixedTier ? tier : choice.tier, amount: priceField(choice.cents) })} disabled={disabled} title={`The ${TIER_WORDS[choice.tier]} cleaning price (${TIER_NIGHTS[choice.tier]})`}>
            {choice.words}
          </button>
        ))}
      </div>
      {words && (
        <span className={`${styles.fieldWords} ${locked ? styles.fieldWordsLocked : ""}`} id={`${id}-words`}>
          {words}
        </span>
      )}
    </>
  );
}
