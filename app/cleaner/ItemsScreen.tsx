"use client";

/**
 * What was bought: one card per receipt line — the item, how many, and the
 * amount on the receipt, which is the line's total as printed: for all of
 * that item together, never for one (D1; the quantity is never multiplied
 * into it). Under the amount, a line that follows "How many" says so in
 * words ("For all 3 together, as printed"), because "Price paid" beside
 * "How many" read as either. Item names are suggested from the ones already
 * in use, so the same thing is picked rather than typed a new way. The total
 * is shown to check against the receipt; it is added up here for display
 * only and never stored.
 *
 * The receipt photo stays at the top, and opens full size, so the items can
 * be read off it.
 *
 * ── Read from the photo (dispatch 20) ──
 * Under the photo, a quiet line says what the reading is doing: reading,
 * how many items it filled in (and what it had to leave off, so the total
 * here is not taken for the receipt's), or that it could not read the photo.
 * A line it filled in carries "From the photo"; once the cleaner changes it,
 * "Edited". Every line is the cleaner's to change, remove or add to, and
 * what they send is what is stored.
 */

import { useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, Minus, Plus, X } from "lucide-react";
import {
  isEdited,
  lineProblems,
  readPrice,
  readQuantity,
  stepQuantity,
  type DraftLine,
  type LineProblems,
} from "@/app/lib/cleaner-draft";
import { LIMITS, formatCents } from "@/app/lib/cleaners/model";
import { fold, matchRank } from "@/app/lib/cleaners/text";
import styles from "./cleaner.module.css";

/** How many suggestions show under an item at once. */
const SUGGESTIONS_SHOWN = 5;

/** What the reading of the current photo is doing, for the note under the photo. */
export type ReadingStatus =
  | { kind: "none" }
  | { kind: "reading" }
  | { kind: "read"; applied: number; leftOut: { count: number; cents: number } }
  | { kind: "failed" };

interface ItemsScreenProps {
  propertyName: string;
  photoUrl: string | null;
  lines: DraftLine[];
  itemNames: string[];
  reading: ReadingStatus;
  /** After a Send with something missing: show what, under each field. */
  showProblems: boolean;
  /** Upload progress from 0 to 1 while sending; null otherwise. */
  sending: number | null;
  /** Why the last Send did not go through, in a few words. */
  sendMessage: string | null;
  totalCents: number;
  onBack: () => void;
  onChangeLine: (key: string, change: Partial<Omit<DraftLine, "key">>) => void;
  onAddLine: () => void;
  onRemoveLine: (key: string) => void;
  onSend: () => void;
  onStartOver: () => void;
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

/**
 * What the amount is, in words that follow "How many": the receipt's amount
 * for all of them together, never for one.
 */
function amountHint(quantity: string | null): string {
  if (quantity === null || quantity === "1") return "As printed on the receipt";
  return /^[0-9]+$/.test(quantity) ? `For all ${quantity} together, as printed` : "For all of it together, as printed";
}

/** The quiet line under the photo. Nothing while there is nothing to say. */
function ReadingNote({ reading }: { reading: ReadingStatus }) {
  if (reading.kind === "none") return null;
  if (reading.kind === "reading") {
    return (
      <p className={styles.readingNote} role="status">
        <span className={`${styles.spinner} ${styles.spinnerSmall}`} aria-hidden />
        <span>Reading the receipt…</span>
      </p>
    );
  }
  if (reading.kind === "failed") {
    return (
      <p className={styles.readingNote} role="status">
        The receipt couldn’t be read. Type the items.
      </p>
    );
  }
  const { applied, leftOut } = reading;
  return (
    <p className={styles.readingNote} role="status">
      {applied === 1 ? "1 item" : `${applied} items`} read from the photo. Check each one.
      {leftOut.count > 0 &&
        ` ${leftOut.count === 1 ? "One line" : `${leftOut.count} lines`} on the receipt (${formatCents(leftOut.cents)}) couldn’t be added here, so the total below will differ from the receipt.`}
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

function ItemName({
  id,
  value,
  itemNames,
  invalid,
  describedBy,
  onChange,
  onPicked,
}: {
  id: string;
  value: string;
  itemNames: string[];
  invalid: boolean;
  describedBy?: string;
  onChange: (name: string) => void;
  onPicked: () => void;
}) {
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

function ItemCard({
  line,
  number,
  removable,
  itemNames,
  problems,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  number: number;
  removable: boolean;
  itemNames: string[];
  problems: LineProblems;
  onChange: (change: Partial<Omit<DraftLine, "key">>) => void;
  onRemove: () => void;
}) {
  const base = `line-${line.key}`;
  const quantity = readQuantity(line.quantity);
  const focusPrice = () => document.getElementById(`${base}-price`)?.focus();
  const hasProblem = Object.keys(problems).length > 0;

  return (
    <li className={styles.itemCard} data-problem={hasProblem || undefined}>
      <div className={styles.itemHead}>
        <span className={styles.itemNumberWrap}>
          <span className={styles.itemNumber}>Item {number}</span>
          {line.ai &&
            (isEdited(line) ? (
              <span className={`${styles.aiTag} ${styles.aiTagEdited}`}>Edited</span>
            ) : (
              <span className={styles.aiTag}>From the photo</span>
            ))}
        </span>
        {removable && (
          <button type="button" className={styles.removeButton} aria-label={`Remove item ${number}`} onClick={onRemove}>
            <X aria-hidden />
          </button>
        )}
      </div>

      <label className={styles.fieldLabel} htmlFor={`${base}-name`}>
        Item
      </label>
      <ItemName
        id={`${base}-name`}
        value={line.name}
        itemNames={itemNames}
        invalid={!!problems.name}
        describedBy={problems.name ? `${base}-name-problem` : undefined}
        onChange={(name) => onChange({ name })}
        onPicked={focusPrice}
      />
      <Problem id={`${base}-name-problem`} text={problems.name} />

      <div className={styles.itemRow}>
        <div className={styles.itemRowCell}>
          <label className={styles.fieldLabel} htmlFor={`${base}-quantity`}>
            How many
          </label>
          <div className={styles.stepper}>
            <button
              type="button"
              className={styles.stepButton}
              aria-label="One fewer"
              disabled={quantity === null || Number(quantity) <= 1}
              onClick={() => onChange({ quantity: stepQuantity(line.quantity, -1) })}
            >
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
            <button
              type="button"
              className={styles.stepButton}
              aria-label="One more"
              onClick={() => onChange({ quantity: stepQuantity(line.quantity, 1) })}
            >
              <Plus aria-hidden />
            </button>
          </div>
          <Problem id={`${base}-quantity-problem`} text={problems.quantity} />
        </div>

        <div className={styles.itemRowCell}>
          <label className={styles.fieldLabel} htmlFor={`${base}-price`}>
            Amount on receipt
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
              aria-describedby={problems.price ? `${base}-price-hint ${base}-price-problem` : `${base}-price-hint`}
              onChange={(e) => onChange({ price: e.target.value })}
              // "8" becomes "8.00": what will be sent, shown before it is.
              onBlur={() => {
                const read = readPrice(line.price);
                if (read && read.text !== line.price) onChange({ price: read.text });
              }}
            />
          </div>
          <p id={`${base}-price-hint`} className={styles.fieldHint}>
            {amountHint(quantity)}
          </p>
          <Problem id={`${base}-price-problem`} text={problems.price} />
        </div>
      </div>
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

export function ItemsScreen(props: ItemsScreenProps) {
  const { propertyName, photoUrl, lines, itemNames, reading, showProblems, sending, sendMessage, totalCents } = props;
  const [viewing, setViewing] = useState(false);

  let sendLabel: ReactNode = "Send";
  if (sending !== null) sendLabel = sending < 1 ? `Sending… ${Math.round(sending * 100)}%` : "Sending…";

  if (viewing && photoUrl) return <PhotoViewer url={photoUrl} onClose={() => setViewing(false)} />;

  return (
    <main className={styles.screen}>
      <header className={styles.topBar}>
        <button type="button" className={styles.backButton} onClick={props.onBack} disabled={sending !== null}>
          <ChevronLeft aria-hidden />
          <span>Back</span>
        </button>
        <p className={styles.topBarProperty}>{propertyName}</p>
      </header>

      <h1 className={styles.title}>What did you buy?</h1>

      {photoUrl && (
        <button type="button" className={styles.thumbButton} onClick={() => setViewing(true)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="" />
          <span>See the receipt</span>
        </button>
      )}
      <ReadingNote reading={reading} />

      {/* Nothing changes under a send in flight. */}
      <ol className={styles.itemList} inert={sending !== null}>
        {lines.map((line, i) => (
          <ItemCard
            key={line.key}
            line={line}
            number={i + 1}
            removable={lines.length > 1}
            itemNames={itemNames}
            problems={showProblems ? lineProblems(line) : {}}
            onChange={(change) => props.onChangeLine(line.key, change)}
            onRemove={() => props.onRemoveLine(line.key)}
          />
        ))}
      </ol>

      {lines.length < LIMITS.LINES_MAX && (
        <button type="button" className={styles.secondary} onClick={props.onAddLine} disabled={sending !== null}>
          <Plus aria-hidden />
          <span>Add item</span>
        </button>
      )}

      <button type="button" className={styles.startOver} onClick={props.onStartOver} disabled={sending !== null}>
        Start over
      </button>

      <div className={styles.bottomBar}>
        {sendMessage && (
          <p className={styles.problem} role="alert">
            {sendMessage}
          </p>
        )}
        <p className={styles.total}>
          <span>Total</span>
          <span>{formatCents(totalCents)}</span>
        </p>
        <button
          type="button"
          className={styles.primary}
          onClick={props.onSend}
          disabled={sending !== null}
          aria-live="polite"
        >
          {sendLabel}
        </button>
        {sending !== null && (
          <div className={styles.progress} aria-hidden>
            <div style={{ width: `${Math.round(sending * 100)}%` }} />
          </div>
        )}
      </div>
    </main>
  );
}
