"use client";

/**
 * A handyman's one screen after the property (dispatch 24): what was done,
 * and the price. No photo, no items, no reading. Send goes to
 * POST /api/cleaner/work; the entry always waits for an admin's approval.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { readPrice, type WorkDraft, type WorkProblems } from "@/app/lib/work-draft";
import { LIMITS, formatCents } from "@/app/lib/cleaners/model";
import styles from "./cleaner.module.css";
import { CleanerBar } from "./CleanerBar";

interface WorkScreenProps {
  propertyName: string;
  draft: WorkDraft;
  problems: WorkProblems;
  /** True while a send is in flight. */
  sending: boolean;
  /** Why the last Send did not go through, in a few words. */
  sendMessage: string | null;
  onBack: () => void;
  onChange: (change: Partial<Pick<WorkDraft, "description" | "price">>) => void;
  onSend: () => void;
  onStartOver: () => void;
}

function Problem({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} className={styles.fieldProblem}>
      {text}
    </p>
  );
}

export function WorkScreen({ propertyName, draft, problems, sending, sendMessage, onBack, onChange, onSend, onStartOver }: WorkScreenProps) {
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const price = readPrice(draft.price);

  // The description takes the keyboard on arrival.
  useEffect(() => {
    descriptionRef.current?.focus();
  }, []);

  let sendLabel: ReactNode = "Send";
  if (sending) sendLabel = "Sending…";

  return (
    <>
      <CleanerBar onBack={onBack} backDisabled={sending} title={propertyName} tag="Work" />
      <main className={styles.screen}>
        <h1 className={styles.title}>What did you do?</h1>

        <div className={`${styles.taxCard} ${problems.description ? styles.taxCardProblem : ""}`} inert={sending} data-problem={problems.description ? true : undefined}>
          <label className={styles.fieldLabel} htmlFor="work-description">
            Work done
          </label>
          <textarea
            id="work-description"
            ref={descriptionRef}
            className={`${styles.field} ${styles.workDescription} ${problems.description ? styles.fieldInvalid : ""}`}
            rows={3}
            maxLength={LIMITS.WORK_DESCRIPTION_MAX}
            value={draft.description}
            autoComplete="off"
            autoCapitalize="sentences"
            aria-invalid={!!problems.description}
            aria-describedby={problems.description ? "work-description-hint work-description-problem" : "work-description-hint"}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <p id="work-description-hint" className={styles.fieldHint}>
            In a few words, like “Replaced the kitchen faucet cartridge and resealed the sink drain”. {draft.description.length}/{LIMITS.WORK_DESCRIPTION_MAX}
          </p>
          <Problem id="work-description-problem" text={problems.description} />
        </div>

        <div className={`${styles.taxCard} ${problems.price ? styles.taxCardProblem : ""}`} inert={sending} data-problem={problems.price ? true : undefined}>
          <label className={styles.fieldLabel} htmlFor="work-price">
            Price
          </label>
          <div className={`${styles.priceField} ${problems.price ? styles.fieldInvalid : ""}`}>
            <span aria-hidden>$</span>
            <input
              id="work-price"
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={draft.price}
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={!!problems.price}
              aria-describedby={problems.price ? "work-price-hint work-price-problem" : "work-price-hint"}
              onChange={(e) => onChange({ price: e.target.value })}
              onBlur={() => {
                const read = readPrice(draft.price);
                if (read && read.text !== draft.price) onChange({ price: read.text });
              }}
            />
          </div>
          <p id="work-price-hint" className={styles.fieldHint}>
            What you are charging for this work, tax included if you charge it.
          </p>
          <Problem id="work-price-problem" text={problems.price} />
        </div>

        <button type="button" className={styles.startOver} onClick={onStartOver} disabled={sending}>
          Start over
        </button>

        <div className={styles.bottomBar}>
          {sendMessage && (
            <p className={styles.problem} role="alert">
              {sendMessage}
            </p>
          )}
          <p className={styles.total}>
            <span>Price</span>
            <span>{price ? formatCents(price.cents) : "—"}</span>
          </p>
          <button type="button" className={styles.primary} onClick={onSend} disabled={sending} aria-live="polite">
            {sendLabel}
          </button>
        </div>
      </main>
    </>
  );
}
