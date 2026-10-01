"use client";

/**
 * The Details tab (dispatch 23F): Report For, the management fee and its
 * rate, the carried balance, and the notes — the statement editor's blocks
 * of dispatch 23E, on the property's page.
 *
 * "Report For" is the property's record, saved on its own through its route
 * 800 ms after the last change, so the unit's info shows the same; the
 * fee, the balance and the notes are the draft's and save with it. The fee's
 * amount is the rate on the base — prefilled from the revenue lines — until
 * the admin types an amount, which is then overwritten; its label is
 * prefilled until edited. The carried balance is offered from the previous
 * month's closing figure and never applied by code.
 *
 * A finished month shows the frozen values, disabled.
 */

import { formatCents } from "@/app/lib/cleaners/model";
import { STATEMENT_LIMITS, monthLabel, type MonthlyReportView, type PropertyManagementView } from "@/app/lib/reports/model";
import { carriedSuggestion, feeRateSuggestion } from "@/app/lib/reports/statement";
import { amountField, readAmount } from "../costs/cost-display";
import { feeNow, rateField, type FeeDraft, type ReportForDraft, type Typed } from "./statement-form";
import styles from "./page.module.css";

interface Props {
  typed: Typed;
  readOnly: boolean;
  onChange: (next: Typed) => void;
  reportFor: ReportForDraft;
  reportForState: "saved" | "saving" | "unsaved" | "failed";
  onReportFor: (next: ReportForDraft) => void;
  /** The finished statement, when the month is finished: its frozen Report For and figures. */
  finishedReport: MonthlyReportView | null;
  /** The previous month's current statement, for the suggestions. */
  previous: MonthlyReportView | null;
  management: PropertyManagementView | null;
  /** The revenue the typed lines add up to, the fee's base when not edited. */
  revenueCents: number;
  /** The carried balance as parsed; null when none or unreadable. */
  carriedCents: number | null;
}

export function DetailsTab({ typed, readOnly, onChange, reportFor, reportForState, onReportFor, finishedReport, previous, management, revenueCents, carriedCents }: Props) {
  const fee = typed.fee ? feeNow(typed.fee, revenueCents) : null;
  const setFee = (patch: Partial<FeeDraft>) => typed.fee && onChange({ ...typed, fee: { ...typed.fee, ...patch } });
  const suggestedCarried = carriedSuggestion(previous);
  /** A statement finished before the Payment Summary has no Report For of its own: the block is blank. */
  const legacyView = readOnly && finishedReport?.legacy === true;
  const shownName = readOnly ? (finishedReport?.reportFor?.name ?? "") : reportFor.name;
  const shownAddress = readOnly ? (finishedReport?.reportFor?.address ?? "") : reportFor.address;

  return (
    <>
      {/* ── Report For ── */}
      <section className={styles.block} aria-label="Report For">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle} title="Saved to the property; the unit's info shows the same">Report For</h3>
          {!readOnly && reportForState === "failed" && <span className={styles.noteWarn}>Not saved</span>}
          {!readOnly && reportForState === "saving" && <span className={styles.note}>Saving…</span>}
        </div>
        {/* Name and address side by side, so the tab's four blocks fit a 1,280 × 800 window (Kian, 2026-10-01). */}
        <div className={styles.twoCols}>
          <div>
            <label className={styles.fieldLabel} htmlFor="report-for-name">Name</label>
            <input id="report-for-name" className={styles.textInput} value={legacyView ? "" : shownName} maxLength={STATEMENT_LIMITS.REPORT_FOR_NAME_MAX} disabled={readOnly} placeholder="Name" onChange={(e) => onReportFor({ ...reportFor, name: e.target.value })} />
          </div>
          <div>
            <label className={styles.fieldLabel} htmlFor="report-for-address">Address</label>
            <textarea id="report-for-address" className={`${styles.textInput} ${styles.addressInput}`} value={legacyView ? "" : shownAddress} maxLength={STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} disabled={readOnly} placeholder={"321-20 John St.\nToronto, ON, M5V 0G5"} rows={2} onChange={(e) => onReportFor({ ...reportFor, address: e.target.value })} />
          </div>
        </div>
      </section>

      {/* ── Fee ── */}
      <section className={styles.block} aria-label="Management fee">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>Management fee</h3>
          <span className={styles.blockTotal}>{fee?.amountCents != null ? formatCents(-fee.amountCents) : "—"}</span>
        </div>
        {typed.fee && fee ? (
          <div className={styles.feeGrid}>
            <div>
              <label className={styles.fieldLabel} htmlFor="fee-rate">Rate (%)</label>
              <input id="fee-rate" className={`${styles.textInput} ${styles.amountInput} ${!readOnly && typed.fee.rate.trim() !== "" && fee.rateBp === null ? styles.inputInvalid : ""}`} inputMode="decimal" value={typed.fee.rate} disabled={readOnly} placeholder="20" onChange={(e) => setFee({ rate: e.target.value })} />
            </div>
            <div>
              <label className={styles.fieldLabel} htmlFor="fee-base">Of (the base)</label>
              <input
                id="fee-base"
                className={`${styles.textInput} ${styles.amountInput} ${!readOnly && fee.baseCents === null ? styles.inputInvalid : ""}`}
                inputMode="decimal"
                value={typed.fee.baseEdited ? typed.fee.base : amountField(revenueCents)}
                disabled={readOnly}
                onChange={(e) => setFee({ base: e.target.value, baseEdited: true })}
                onBlur={() => {
                  if (!typed.fee) return;
                  const read = readAmount(typed.fee.base);
                  if (typed.fee.baseEdited && read && read !== typed.fee.base) setFee({ base: read });
                }}
              />
              {!readOnly && typed.fee.baseEdited && (
                <button type="button" className={styles.linkButton} onClick={() => setFee({ base: "", baseEdited: false })}>
                  Use the revenue sum, {formatCents(revenueCents)}
                </button>
              )}
            </div>
            <div>
              <label className={styles.fieldLabel} htmlFor="fee-amount">Amount</label>
              <input
                id="fee-amount"
                className={`${styles.textInput} ${styles.amountInput} ${!readOnly && fee.amountCents === null ? styles.inputInvalid : ""}`}
                inputMode="decimal"
                value={typed.fee.amountEdited ? typed.fee.amount : fee.computedCents === null ? "" : amountField(fee.computedCents)}
                disabled={readOnly}
                placeholder={fee.computedCents === null ? "0.00" : undefined}
                onChange={(e) => setFee({ amount: e.target.value, amountEdited: true })}
                onBlur={() => {
                  if (!typed.fee) return;
                  const read = readAmount(typed.fee.amount);
                  if (typed.fee.amountEdited && read && read !== typed.fee.amount) setFee({ amount: read });
                }}
              />
              {fee.computedCents !== null && fee.amountCents !== null && fee.amountCents !== fee.computedCents ? (
                <span className={styles.noteWarn}>
                  overwritten · computed {formatCents(fee.computedCents)}
                  {!readOnly && (
                    <>
                      {" · "}
                      <button type="button" className={styles.linkButton} onClick={() => setFee({ amount: "", amountEdited: false })}>
                        Use it
                      </button>
                    </>
                  )}
                </span>
              ) : fee.computedCents !== null ? (
                <span className={styles.note}>computed from the rate</span>
              ) : null}
            </div>
            <div className={styles.feeLabelCell}>
              <label className={styles.fieldLabel} htmlFor="fee-label">Label</label>
              <input id="fee-label" className={`${styles.textInput} ${!readOnly && fee.label.trim() === "" ? styles.inputInvalid : ""}`} value={fee.label} maxLength={STATEMENT_LIMITS.FEE_LABEL_MAX} disabled={readOnly} onChange={(e) => setFee({ label: e.target.value, labelEdited: true })} />
              {!readOnly && typed.fee.labelEdited && (
                <button type="button" className={styles.linkButton} onClick={() => setFee({ label: "", labelEdited: false })}>
                  Use the standard label
                </button>
              )}
            </div>
            {!readOnly && (
              <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => onChange({ ...typed, fee: null })}>
                No fee
              </button>
            )}
          </div>
        ) : (
          <p className={styles.note}>
            No fee.{" "}
            {!readOnly && (
              <button type="button" className={styles.linkButton} onClick={() => onChange({ ...typed, fee: { label: "", rate: rateField(feeRateSuggestion(previous, management)), base: "", amount: "", baseEdited: false, amountEdited: false, labelEdited: false } })}>
                Add a fee
              </button>
            )}
          </p>
        )}
      </section>

      {/* ── Carried balance ── */}
      <section className={styles.block} aria-label="Carried balance">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>Carried balance</h3>
          <span className={styles.blockTotal}>{carriedCents !== null ? formatCents(-carriedCents) : "—"}</span>
        </div>
        {typed.carried ? (
          <div className={styles.carriedGrid}>
            <div>
              <label className={styles.fieldLabel} htmlFor="carried-label">Label</label>
              <input id="carried-label" className={`${styles.textInput} ${!readOnly && typed.carried.label.trim() === "" ? styles.inputInvalid : ""}`} value={typed.carried.label} maxLength={STATEMENT_LIMITS.CARRIED_LABEL_MAX} disabled={readOnly} placeholder="Balance From June" onChange={(e) => onChange({ ...typed, carried: { ...typed.carried!, label: e.target.value } })} />
            </div>
            <div>
              <label className={styles.fieldLabel} htmlFor="carried-amount">Amount deducted</label>
              <input
                id="carried-amount"
                className={`${styles.textInput} ${styles.amountInput} ${!readOnly && readAmount(typed.carried.amount) === null ? styles.inputInvalid : ""}`}
                inputMode="decimal"
                value={typed.carried.amount}
                disabled={readOnly}
                placeholder="359.96"
                onChange={(e) => onChange({ ...typed, carried: { ...typed.carried!, amount: e.target.value, fromReportId: null } })}
                onBlur={() => {
                  const read = readAmount(typed.carried?.amount ?? "");
                  if (read && typed.carried && read !== typed.carried.amount) onChange({ ...typed, carried: { ...typed.carried, amount: read } });
                }}
              />
              <span className={styles.note}>{typed.carried.fromReportId ? "from the previous statement" : "typed"}</span>
            </div>
            {!readOnly && (
              <button type="button" className={`${styles.btnGhost} ${styles.btnSmall}`} onClick={() => onChange({ ...typed, carried: null })}>
                No balance
              </button>
            )}
          </div>
        ) : (
          <p className={styles.note}>
            {suggestedCarried && previous ? `${monthLabel(previous.month)} closed at ${formatCents(previous.payableCents)}. ` : "None. "}
            {!readOnly && suggestedCarried && (
              <button type="button" className={styles.linkButton} onClick={() => onChange({ ...typed, carried: { label: suggestedCarried.label, amount: amountField(suggestedCarried.amountCents), fromReportId: suggestedCarried.fromReportId } })}>
                Carry it: {suggestedCarried.label} {formatCents(suggestedCarried.amountCents)}
              </button>
            )}
            {!readOnly && (
              <>
                {suggestedCarried ? " · " : ""}
                <button type="button" className={styles.linkButton} onClick={() => onChange({ ...typed, carried: { label: "", amount: "", fromReportId: null } })}>
                  Type a balance
                </button>
              </>
            )}
          </p>
        )}
      </section>

      {/* ── Notes ── */}
      <section className={styles.block} aria-label="Notes">
        <div className={styles.blockHead}>
          <h3 className={styles.blockTitle}>Notes</h3>
          <span className={styles.note}>
            {typed.notes.length}/{STATEMENT_LIMITS.NOTES_MAX}
          </span>
        </div>
        <textarea className={styles.textInput} value={typed.notes} maxLength={STATEMENT_LIMITS.NOTES_MAX} disabled={readOnly} onChange={(e) => onChange({ ...typed, notes: e.target.value })} placeholder="Printed at the foot, as typed" aria-label="Notes" />
      </section>
    </>
  );
}
