"use client";

/**
 * The receipt (Kian's ruling 4 of 2026-10-16; rebuilt to his rulings of 2026-11-02, Build 1, item 6): after the
 * camera, one screen with the photo, the lines, the tax and the property, and Send pinned at the bottom.
 *
 * Each line is the item and the amount as printed — the line's total for all of that item together, never for one
 * (D1); the quantity is never multiplied into it. "How many" hides behind a small "×1" control (default 1): a tap
 * opens the stepper. One short tax line, "Tax (if on the receipt)". "Start over" sits under the photo with "Take
 * again". Item names are suggested from the ones already in use.
 *
 * The reader also reads the total the receipt prints: the pinned bar shows "Receipt total $45.20 · your lines
 * $45.20 ✓", or the two figures in amber when they differ, with "Different from the receipt. You can still send." A
 * difference never blocks sending; the server marks the entry for the admin. The total here is added up for display
 * only and never stored.
 *
 * ── Read from the photo (dispatches 20 and 21) ──
 * While the photo is being read the items and the tax are locked: nothing can be typed there, and a panel says the
 * receipt is being read. The property can be checked and changed meanwhile. When the answer comes the lines are
 * there; the tax the receipt prints fills the tax field, never a line. A reading that failed unlocks the form for
 * typing, with a quiet note. Every line is the cleaner's to change, remove or add to, and what they send is what is
 * stored. No tag under 16 px: the "From the photo" and "Edited" pills are gone; the server keeps the record of what
 * was read and what was changed.
 */

import { useMemo, useState, type ReactNode } from "react";
import { Minus, Plus, X } from "lucide-react";
import { itemsCents, lineProblems, readPrice, readQuantity, readTax, stepQuantity, taxProblem, type DraftLine, type LineProblems } from "@/app/lib/cleaner-draft";
import { LIMITS, formatCents } from "@/app/lib/cleaners/model";
import { DATED_BEFORE_STATEMENTS } from "@/app/lib/cleaners/reading-date";
import { fold, matchRank } from "@/app/lib/cleaners/text";
import styles from "./cleaner.module.css";
import { AskDialog } from "./AskDialog";
import { CleanerBar } from "./CleanerBar";
import { PropertyChoice } from "./PropertyChoice";
import { usePinnedHeight } from "./usePinnedHeight";

/** How many suggestions show under an item at once. */
const SUGGESTIONS_SHOWN = 5;

/** What the reading of the current photo is doing, for the note under the photo. */
export type ReadingStatus =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "read"; applied: number; leftOut: { count: number; cents: number } }
  | { kind: "failed" }
  /** The reading dates the receipt before the first statement month: it cannot be sent here (Kian, 2026-11-01). */
  | { kind: "dated-before" };

interface ReceiptScreenProps {
  /** The property the receipt is for, by its name for cleaners; null until one is chosen. */
  property: { name: string | null } | null;
  photoUrl: string | null;
  lines: DraftLine[];
  itemNames: string[];
  reading: ReadingStatus;
  /** The tax as typed. */
  tax: string;
  /** The total the receipt prints, as the reading read it; null when there is no reading or it printed none. */
  printedTotalCents: number | null;
  /** After a Send with something missing: show what, under each field, and at the property when none is chosen. */
  showProblems: boolean;
  /** Upload progress from 0 to 1 while sending; null otherwise. */
  sending: number | null;
  /** Why the last Send did not go through, in a few words. */
  sendMessage: string | null;
  totalCents: number;
  onBack: () => void;
  onChangeLine: (key: string, change: Partial<Omit<DraftLine, "key">>) => void;
  onChangeTax: (tax: string) => void;
  onAddLine: () => void;
  onRemoveLine: (key: string) => void;
  onSend: () => void;
  onStartOver: () => void;
  /** Change, or Choose: the property list. */
  onChangeProperty: () => void;
  /** Take again: the camera, for a new photo. */
  onRetake: () => void;
}

/** The item names that match what is typed, best first, leaving out the one already there. */
function suggest(itemNames: string[], typed: string): string[] {
  const query = fold(typed);
  if (query === "") return [];
  return itemNames
    .map((name, order) => ({ name, order, rank: fold(name) === query ? null : matchRank(name, typed) }))
    .filter((match): match is { name: string; order: number; rank: 0 | 1 | 2 } => match.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, SUGGESTIONS_SHOWN)
    .map(({ name }) => name);
}

/** The line under the photo once the reading has answered. Nothing while there is nothing to say. */
function ReadingNote({ reading }: { reading: ReadingStatus }) {
  if (reading.kind === "none" || reading.kind === "reading") return null;
  if (reading.kind === "failed") {
    return (
      <p className={styles.readingNote} role="status">
        The receipt couldn’t be read. Type the items.
      </p>
    );
  }
  if (reading.kind === "dated-before") {
    return (
      <p className={styles.problem} role="alert">
        {DATED_BEFORE_STATEMENTS}
      </p>
    );
  }
  const { applied, leftOut } = reading;
  return (
    <p className={styles.readingNote} role="status">
      {applied === 1 ? "1 line" : `${applied} lines`} read from the photo. Check each one.
      {leftOut.count > 0 && ` ${leftOut.count === 1 ? "One line" : `${leftOut.count} lines`} on the receipt (${formatCents(leftOut.cents)}) couldn’t be added here.`}
    </p>
  );
}

function Problem({ id, text }: { id: string; text?: string }) {
  if (!text) return null;
  return (
    <p id={id} className={styles.fieldProblem}>
      {text}
    </p>
  );
}

function ItemName({ id, value, itemNames, invalid, describedBy, onChange, onPicked }: { id: string; value: string; itemNames: string[]; invalid: boolean; describedBy?: string; onChange: (name: string) => void; onPicked: () => void }) {
  const [open, setOpen] = useState(false);
  const suggestions = useMemo(() => (open ? suggest(itemNames, value) : []), [open, itemNames, value]);
  const listId = `${id}-suggestions`;

  return (
    <div className={styles.suggestWrap}>
      <input
        id={id}
        className={`${styles.field} ${invalid ? styles.fieldInvalid : ""}`}
        type="text"
        value={value}
        maxLength={LIMITS.LINE_NAME_MAX}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="sentences"
        enterKeyHint="next"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-invalid={invalid}
        aria-describedby={describedBy}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        // Late enough for a tap on a suggestion to land first.
        onBlur={() => window.setTimeout(() => setOpen(false), 200)}
      />
      {suggestions.length > 0 && (
        <ul id={listId} role="listbox" className={styles.suggestions} aria-label="Suggestions">
          {suggestions.map((name) => (
            <li key={name} role="option" aria-selected={false}>
              <button
                type="button"
                className={styles.suggestion}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                  onPicked();
                }}
              >
                {name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ItemCard({ line, number, removable, itemNames, problems, onChange, onRemove }: { line: DraftLine; number: number; removable: boolean; itemNames: string[]; problems: LineProblems; onChange: (change: Partial<Omit<DraftLine, "key">>) => void; onRemove: () => void }) {
  const base = `line-${line.key}`;
  const quantity = readQuantity(line.quantity);
  const focusPrice = () => document.getElementById(`${base}-price`)?.focus();
  const hasProblem = Object.keys(problems).length > 0;
  // "How many" (item 6): behind "×1" until tapped, or already open when it is not 1 or cannot be read.
  const [qtyOpen, setQtyOpen] = useState(false);
  const showQty = qtyOpen || quantity !== "1";

  return (
    <li className={styles.itemCard} data-problem={hasProblem || undefined}>
      <div className={styles.itemHead}>
        <label className={styles.fieldLabel} htmlFor={`${base}-name`}>
          Item {number}
        </label>
        {removable && (
          <button type="button" className={styles.removeButton} aria-label={`Remove item ${number}`} onClick={onRemove}>
            <X aria-hidden />
          </button>
        )}
      </div>
      <ItemName id={`${base}-name`} value={line.name} itemNames={itemNames} invalid={!!problems.name} describedBy={problems.name ? `${base}-name-problem` : undefined} onChange={(name) => onChange({ name })} onPicked={focusPrice} />
      <Problem id={`${base}-name-problem`} text={problems.name} />

      <div className={styles.amountRow}>
        <div className={styles.amountCell}>
          <label className={styles.fieldLabel} htmlFor={`${base}-price`}>
            Amount
          </label>
          <div className={`${styles.priceField} ${problems.price ? styles.fieldInvalid : ""}`}>
            <span aria-hidden>$</span>
            <input
              id={`${base}-price`}
              type="text"
              inputMode="decimal"
              placeholder="0.00"
              value={line.price}
              autoComplete="off"
              enterKeyHint="done"
              aria-invalid={!!problems.price}
              aria-describedby={problems.price ? `${base}-price-problem` : undefined}
              onChange={(e) => onChange({ price: e.target.value })}
              // "8" becomes "8.00": what will be sent, shown before it is.
              onBlur={() => {
                const read = readPrice(line.price);
                if (read && read.text !== line.price) onChange({ price: read.text });
              }}
            />
          </div>
        </div>
        <button type="button" className={`${styles.qtyButton} ${showQty ? styles.qtyButtonOpen : ""}`} aria-expanded={showQty} aria-controls={`${base}-qty`} aria-label={`How many: ${line.quantity}`} onClick={() => setQtyOpen((open) => !open)}>
          ×{quantity ?? line.quantity}
        </button>
      </div>
      <Problem id={`${base}-price-problem`} text={problems.price} />

      {showQty && (
        <div id={`${base}-qty`} className={styles.qtyRow}>
          <label className={styles.fieldLabel} htmlFor={`${base}-quantity`}>
            How many
          </label>
          <div className={styles.stepper}>
            <button type="button" className={styles.stepButton} aria-label="One fewer" disabled={quantity === null || Number(quantity) <= 1} onClick={() => onChange({ quantity: stepQuantity(line.quantity, -1) })}>
              <Minus aria-hidden />
            </button>
            <input
              id={`${base}-quantity`}
              className={`${styles.field} ${styles.stepValue} ${problems.quantity ? styles.fieldInvalid : ""}`}
              type="text"
              inputMode="decimal"
              value={line.quantity}
              autoComplete="off"
              aria-invalid={!!problems.quantity}
              aria-describedby={problems.quantity ? `${base}-quantity-problem` : undefined}
              onChange={(e) => onChange({ quantity: e.target.value })}
              onBlur={() => {
                const read = readQuantity(line.quantity);
                if (read !== null && read !== line.quantity) onChange({ quantity: read });
              }}
            />
            <button type="button" className={styles.stepButton} aria-label="One more" onClick={() => onChange({ quantity: stepQuantity(line.quantity, 1) })}>
              <Plus aria-hidden />
            </button>
          </div>
          <Problem id={`${base}-quantity-problem`} text={problems.quantity} />
        </div>
      )}
    </li>
  );
}

function PhotoViewer({ url, onClose }: { url: string; onClose: () => void }) {
  return (
    <div className={styles.viewer} role="dialog" aria-modal="true" aria-label="Receipt photo">
      <button type="button" className={styles.viewerClose} onClick={onClose} autoFocus>
        <X aria-hidden />
        <span>Close</span>
      </button>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt="The receipt photo, full size" />
    </div>
  );
}

export function ReceiptScreen(props: ReceiptScreenProps) {
  const { property, photoUrl, lines, itemNames, reading, tax, printedTotalCents, showProblems, sending, sendMessage, totalCents } = props;
  const [viewing, setViewing] = useState(false);
  const [askingStartOver, setAskingStartOver] = useState(false);
  const [barRef, barHeight] = usePinnedHeight();
  /** Nothing can be typed while the receipt is being read (dispatch 21), nor while a send is in flight. */
  const locked = reading.kind === "reading" || sending !== null;
  const taxIssue = showProblems ? taxProblem(tax) : undefined;
  const taxRead = readTax(tax);
  const differs = printedTotalCents !== null && printedTotalCents !== totalCents;

  let sendLabel: ReactNode = "Send";
  if (sending !== null) sendLabel = sending < 1 ? `Sending… ${Math.round(sending * 100)}%` : "Sending…";

  if (viewing && photoUrl) return <PhotoViewer url={photoUrl} onClose={() => setViewing(false)} />;

  return (
    <>
      <CleanerBar onBack={props.onBack} backDisabled={sending !== null} />
      <main className={styles.screen} style={{ paddingBottom: barHeight + 16 }}>
        <h1 className={styles.title}>Receipt</h1>

        {photoUrl && (
          <div className={styles.photoRow}>
            <button type="button" className={styles.thumbButton} onClick={() => setViewing(true)}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={photoUrl} alt="" />
              <span>See the receipt</span>
            </button>
            <div className={styles.photoActions}>
              <button type="button" className={styles.textButton} onClick={props.onRetake} disabled={sending !== null}>
                Take again
              </button>
              <button type="button" className={styles.textButton} onClick={() => setAskingStartOver(true)} disabled={locked}>
                Start over
              </button>
            </div>
          </div>
        )}
        {reading.kind === "reading" && (
          <div className={styles.readingLock} role="status" aria-live="polite">
            <span className={styles.spinner} aria-hidden />
            <p>Reading the receipt… The items will appear here in a moment.</p>
          </div>
        )}
        <ReadingNote reading={reading} />

        {/* Nothing changes while the receipt is being read, or under a send in flight. */}
        <ol className={styles.itemList} inert={locked}>
          {lines.map((line, i) => (
            <ItemCard key={line.key} line={line} number={i + 1} removable={lines.length > 1} itemNames={itemNames} problems={showProblems ? lineProblems(line) : {}} onChange={(change) => props.onChangeLine(line.key, change)} onRemove={() => props.onRemoveLine(line.key)} />
          ))}
        </ol>

        {lines.length < LIMITS.LINES_MAX && (
          <button type="button" className={styles.secondary} onClick={props.onAddLine} disabled={locked}>
            <Plus aria-hidden />
            <span>Add item</span>
          </button>
        )}

        {/* The tax, apart from the items (dispatch 21), one line (item 6). */}
        <div className={`${styles.taxRow} ${taxIssue ? styles.taxCardProblem : ""}`} inert={locked} data-problem={taxIssue ? true : undefined}>
          <label className={styles.fieldLabel} htmlFor="entry-tax">
            Tax (if on the receipt)
          </label>
          <div className={`${styles.priceField} ${taxIssue ? styles.fieldInvalid : ""}`}>
            <span aria-hidden>$</span>
            <input id="entry-tax" type="text" inputMode="decimal" placeholder="0.00" value={tax} autoComplete="off" enterKeyHint="done" aria-invalid={!!taxIssue} aria-describedby={taxIssue ? "entry-tax-problem" : undefined} onChange={(e) => props.onChangeTax(e.target.value)} onBlur={() => taxRead && taxRead.text !== tax && props.onChangeTax(taxRead.text)} />
          </div>
          <Problem id="entry-tax-problem" text={taxIssue} />
        </div>
      </main>

      <div ref={barRef} className={styles.pinnedFixed}>
        <div className={styles.pinnedInner}>
          {sendMessage && (
            <p className={styles.problem} role="alert">
              {sendMessage}
            </p>
          )}
          <p className={`${styles.totalCheck} ${printedTotalCents === null ? "" : differs ? styles.totalCheckOff : styles.totalCheckOk}`} aria-live="polite">
            {printedTotalCents === null ? (
              <>
                Your lines <strong>{formatCents(itemsCents(lines) + (taxRead?.cents ?? 0))}</strong>
              </>
            ) : (
              <>
                Receipt total <strong>{formatCents(printedTotalCents)}</strong> · your lines <strong>{formatCents(totalCents)}</strong>
                {differs ? "" : " ✓"}
              </>
            )}
          </p>
          {differs && <p className={styles.totalOffWords}>Different from the receipt. You can still send.</p>}
          <PropertyChoice property={property} problem={showProblems && property === null} disabled={sending !== null} onChange={props.onChangeProperty} />
          <button type="button" className={styles.primary} onClick={props.onSend} disabled={locked} aria-live="polite">
            {sendLabel}
          </button>
          {sending !== null && (
            <div className={styles.progress} aria-hidden>
              <div style={{ width: `${Math.round(sending * 100)}%` }} />
            </div>
          )}
        </div>
      </div>

      {askingStartOver && (
        <AskDialog
          title="Start over?"
          words="What you typed and the photo will be removed."
          confirmLabel="Start over"
          cancelLabel="Keep it"
          danger
          onConfirm={() => {
            setAskingStartOver(false);
            props.onStartOver();
          }}
          onCancel={() => setAskingStartOver(false)}
        />
      )}
    </>
  );
}
