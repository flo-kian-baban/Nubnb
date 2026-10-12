"use client";

/**
 * What every section of the property editor is handed, and the small pieces
 * they share: the field's refusal or "Required" line, the import's tint and
 * badge for a field, the panel's head with its missing fields in words, and a
 * list row edited in place (a highlight or a house rule).
 */

import type { Dispatch, KeyboardEvent, ReactNode, SetStateAction } from "react";
import { AlertTriangle, Check, Lock, Pencil, Trash2, X, XCircle } from "lucide-react";
import type { Offer, Property } from "@/app/types/property";
import type { MutationIssue } from "@/app/lib/firebase/properties";
import type { ScrapeFieldStatus } from "@/app/types/scrape";
import type { Notice } from "../../components/Notice";
import type { EditorDraft, MissingField, SectionId, SectionState } from "./model";
import styles from "./editor.module.css";

/**
 * The one list row being edited in place (dispatch 29): an offer, a highlight
 * or a house rule. `include` is an offer in "Not included" being ticked whose
 * category is not known: it is offered again only once the admin picks one.
 */
export type RowEdit =
  | { kind: "offer"; target: Offer; name: string; category: string; include: boolean }
  | { kind: "highlight" | "rule"; index: number; value: string };

/** The row-editing operations the editor owns and the list sections call (row-edits.ts). */
export interface RowEdits {
  rowEdit: RowEdit | null;
  rowEditError: string | null;
  change: (edit: RowEdit) => void;
  commit: () => boolean;
  cancel: () => void;
  startOfferEdit: (offer: Offer, include?: boolean) => void;
  startListEdit: (kind: "highlight" | "rule", index: number) => void;
  keys: (event: KeyboardEvent<HTMLInputElement>) => void;
  addHighlight: (text: string) => boolean;
  removeHighlight: (index: number) => void;
  addRule: (text: string) => boolean;
  removeRule: (index: number) => void;
  /** The reason it was not added, or null. */
  addOffer: (name: string, category: string) => string | null;
  deleteOffer: (offer: Offer) => void;
  toggleOfferAvailable: (offer: Offer) => void;
  toggleOfferStar: (name: string) => void;
  updateOfferIcon: (offer: Offer, svg: string) => void;
  categoryOptions: string[];
}

/** Everything a section is handed. */
export interface SectionContext {
  mode: "new" | "edit";
  draft: EditorDraft;
  /** The document as loaded, on an edit. */
  stored: Property | null;
  setProperty: (update: (prev: Partial<Property>) => Partial<Property>) => void;
  setDraft: Dispatch<SetStateAction<EditorDraft>>;
  /** What the server refused on the last save. */
  issues: MutationIssue[];
  /** The import's per-field report, until the next import or a reload. */
  fieldStatus: ScrapeFieldStatus | null;
  /** A save was tried: required fields still empty are marked. */
  attempted: boolean;
  /** What this section is missing. */
  state: SectionState;
  show: (notice: Notice) => void;
  goTo: (section: SectionId) => void;
  rows: RowEdits;
  /** The name cleaners see: read from its own route; "unavailable" means it could not be read and cannot be changed. */
  cleanerNameState: LoadState;
  /** The statements record, likewise. */
  managementState: LoadState;
}

export type LoadState = "none" | "loading" | "ready" | "unavailable";

// ─── Refusals and required fields ─────────────────────────────

/** The server's messages against this path; or "Required", once a save was tried, for a blocking field still empty. */
export function fieldIssue(ctx: Pick<SectionContext, "issues" | "attempted" | "state">, path: string): string | undefined {
  const said = ctx.issues.filter((i) => i.path === path).map((i) => i.message);
  if (said.length > 0) return said.join(". ");
  if (ctx.attempted && ctx.state.missing.some((m) => m.field === path && m.blocking)) return "Required";
  return undefined;
}

export const isInvalid = (ctx: Pick<SectionContext, "issues" | "attempted" | "state">, path: string): boolean => fieldIssue(ctx, path) !== undefined;

// ─── The import's provenance ──────────────────────────────────

/** A tint on the field's border, from the import's report for that field. */
export function tint(ctx: Pick<SectionContext, "fieldStatus">, field: string): string {
  const report = ctx.fieldStatus?.[field];
  if (!report) return "";
  if (report.status === "extracted") return styles.scrapeExtracted;
  if (report.status === "defaulted") return styles.scrapeDefaulted;
  if (report.status === "admin-entered") return "";
  return styles.scrapeFailed;
}

/** A badge for a control with no border to tint, and beside list labels. */
export function ScrapeBadge({ ctx, field }: { ctx: Pick<SectionContext, "fieldStatus">; field: string }) {
  const report = ctx.fieldStatus?.[field];
  if (!report) return null;
  if (report.status === "extracted") {
    return (
      <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeExtracted}`} title="Read from the Airbnb listing.">
        <Check size={11} aria-hidden /> Imported
      </span>
    );
  }
  if (report.status === "defaulted") {
    return (
      <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeDefaulted}`} title={report.reason}>
        <AlertTriangle size={11} aria-hidden /> Default: {String(report.defaultUsed)}
      </span>
    );
  }
  if (report.status === "admin-entered") {
    return (
      <span className={styles.scrapeBadge} title={report.reason}>
        Enter by hand
      </span>
    );
  }
  return (
    <span className={`${styles.scrapeBadge} ${styles.scrapeBadgeFailed}`} title={report.reason}>
      <XCircle size={11} aria-hidden /> Not found
    </span>
  );
}

// ─── The panel's head ─────────────────────────────────────────

interface PanelProps {
  title: string;
  state: SectionState;
  /** One quiet line under the head. */
  note?: ReactNode;
  /** One of the Nubnb-only sections: says so, once. */
  internal?: boolean;
  children: ReactNode;
}

/** One tile of the bento: a title row (optional), what it holds, its width in twelfths. */
export function Tile({ title, aside, span = 12, className, children }: { title?: ReactNode; aside?: ReactNode; span?: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 12; className?: string; children: ReactNode }) {
  const spanClass = { 3: styles.span3, 4: styles.span4, 5: styles.span5, 6: styles.span6, 7: styles.span7, 8: styles.span8, 9: styles.span9, 12: styles.span12 }[span];
  return (
    <div className={`${styles.tile} ${spanClass} ${className ?? ""}`}>
      {(title || aside) && (
        <div className={styles.tileHead}>
          <span className={styles.tileTitle}>{title}</span>
          {aside && <span className={styles.tileAside}>{aside}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

export function Panel({ title, state, note, internal, children }: PanelProps) {
  const missing = state.missing.map((m) => m.label);
  return (
    <section className={styles.panel} aria-labelledby="section-title">
      <div className={styles.panelHead}>
        <h2 id="section-title" className={styles.panelTitle}>
          {title}
        </h2>
        {state.refused > 0 && (
          <span className={styles.panelRefused}>
            {state.refused === 1 ? "1 field refused" : `${state.refused} fields refused`}
          </span>
        )}
        {missing.length > 0 && <span className={styles.panelMissing}>Missing: {missing.join(", ")}</span>}
      </div>
      {internal && (
        <p className={styles.internalNote}>
          <Lock size={13} aria-hidden /> Nubnb only. Nothing here reaches the public site.
        </p>
      )}
      {note && <p className={styles.panelNote}>{note}</p>}
      <div className={styles.bento}>{children}</div>
    </section>
  );
}

// ─── A list row: a highlight or a house rule ──────────────────

export function ListRow({ kind, text, index, rows }: { kind: "highlight" | "rule"; text: string; index: number; rows: RowEdits }) {
  const editing = rows.rowEdit && rows.rowEdit.kind === kind && rows.rowEdit.index === index ? rows.rowEdit : null;
  const noun = kind === "highlight" ? "highlight" : "rule";
  if (editing) {
    return (
      <>
        <div className={styles.row} data-row-edit>
          <input
            type="text"
            className={`${styles.input} ${styles.rowEditInput}`}
            value={editing.value}
            autoFocus
            aria-label={`Edit ${noun}`}
            onChange={(e) => rows.change({ ...editing, value: e.target.value })}
            onKeyDown={rows.keys}
          />
          <div className={styles.rowActions}>
            <button type="button" className={`${styles.rowBtn} ${styles.rowBtnConfirm}`} title="Save" aria-label={`Save ${noun}`} onClick={rows.commit}>
              <Check size={14} aria-hidden />
            </button>
            <button type="button" className={styles.rowBtn} title="Cancel" aria-label="Cancel" onClick={rows.cancel}>
              <X size={14} aria-hidden />
            </button>
          </div>
        </div>
        {rows.rowEditError && (
          <span className={`${styles.issue} ${styles.rowIssue}`} role="alert">
            {rows.rowEditError}
          </span>
        )}
      </>
    );
  }
  return (
    <div className={styles.row}>
      <span className={styles.rowText}>{text}</span>
      <div className={styles.rowActions}>
        <button type="button" className={styles.rowBtn} title="Edit" aria-label={`Edit ${noun}: ${text}`} onClick={() => rows.startListEdit(kind, index)}>
          <Pencil size={14} aria-hidden />
        </button>
        <button type="button" className={`${styles.rowBtn} ${styles.rowBtnDanger}`} title="Delete" aria-label={`Delete ${noun}: ${text}`} onClick={() => (kind === "highlight" ? rows.removeHighlight(index) : rows.removeRule(index))}>
          <Trash2 size={14} aria-hidden />
        </button>
      </div>
    </div>
  );
}

/** The missing fields of one section, as a short list for a notice. */
export const missingLabels = (missing: MissingField[]) => missing.map((m) => m.label);
