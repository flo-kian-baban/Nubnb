/**
 * The statement as typed on the property page (dispatch 23F; lifted from the
 * statement editor of dispatches 23B–23E): the shapes the fields hold, how a
 * stored draft or a finished report becomes them, how they become the draft
 * the writer previews and the payload the server saves, and the fee as it
 * stands from what is typed.
 *
 * Pure: no React, no fetch. The page keeps the state; this file turns it.
 */

import { amountField, readAmount } from "../costs/cost-display";
import { feeComputed, isDayText, lineAmount, lineFromIncomeRow, rateText, type Carried, type Fee, type Line, type MonthlyReportView, type PropertyManagementView, type StatementDraftView } from "@/app/lib/reports/model";
import { feeLabelFor, feeRateSuggestion, referenceSuggestion } from "@/app/lib/reports/statement";
import type { DraftPayload, LinePayload } from "@/app/lib/reports-client";

/** A line as typed. */
export interface LineDraft {
  id: string;
  description: string;
  from: string;
  to: string;
  quantity: string;
  rate: string;
  /** Present on a line loaded with what a row written before dispatch 23D carried; saved back as loaded. */
  details?: { source?: Line["source"]; reference?: string | null };
}
/** The fee as typed. The three flags say what the admin has taken over; what they have not follows the lines. */
export interface FeeDraft {
  label: string;
  rate: string;
  base: string;
  amount: string;
  baseEdited: boolean;
  amountEdited: boolean;
  labelEdited: boolean;
}
export interface CarriedDraft {
  label: string;
  amount: string;
  fromReportId: string | null;
}
export interface Typed {
  reference: string;
  reportDate: string;
  lines: LineDraft[];
  fee: FeeDraft | null;
  carried: CarriedDraft | null;
  notes: string;
}
export interface ReportForDraft {
  name: string;
  address: string;
}

export const newId = () => (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).slice(0, 36);

/** "20" or "12.5" from basis points, for the rate field. */
export const rateField = (bp: number | null) => (bp === null ? "" : rateText(bp).replace("%", ""));

/** Basis points from "20" or "12.5"; null when it is not a rate. */
export function readRate(typed: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(typed.trim());
  if (!match) return null;
  const bp = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return bp > 10_000 ? null : bp;
}

/** Whole cents from an amount in the server's form, "7.98" or "-5.00". */
export const centsOf = (amount: string) => Math.round(Number(amount.replace("-", "")) * 100) * (amount.startsWith("-") ? -1 : 1);

/** A line's quantity as typed: a whole number of 1 or more, else null. */
export function readQuantity(typed: string): number | null {
  return /^\d{1,4}$/.test(typed.trim()) ? Number(typed.trim()) : null;
}

export function lineDraftOf(line: Line): LineDraft {
  const details: LineDraft["details"] = {};
  if (line.source !== undefined) details.source = line.source;
  if ("reference" in line) details.reference = line.reference ?? null;
  return { id: line.id, description: line.description, from: line.from ?? "", to: line.to ?? "", quantity: String(line.quantity), rate: amountField(line.rateCents), ...(Object.keys(details).length > 0 ? { details } : {}) };
}

/** The stored fee as typed: what the admin had taken over is told from what the stored figures say. */
export function feeDraftOf(fee: Fee, revenueCents: number): FeeDraft {
  const label = feeLabelFor(fee.rateBasisPoints, fee.baseCents);
  return {
    label: fee.label,
    rate: rateField(fee.rateBasisPoints),
    base: amountField(fee.baseCents),
    amount: amountField(fee.amountCents),
    baseEdited: fee.baseCents !== revenueCents,
    amountEdited: fee.overwritten,
    labelEdited: fee.label !== label,
  };
}

/** A fee as typed before anything is typed: the rate offered, everything else following the lines. */
export function freshFee(rateBasisPoints: number | null): FeeDraft | null {
  return rateBasisPoints === null ? null : { label: "", rate: rateField(rateBasisPoints), base: "", amount: "", baseEdited: false, amountEdited: false, labelEdited: false };
}

export const revenueOf = (lines: Line[]) => lines.filter((line) => line.amountCents > 0).reduce((sum, line) => sum + line.amountCents, 0);

export function fromStored(draft: Pick<StatementDraftView, "reference" | "reportDate" | "lines" | "fee" | "carried" | "notes">, today: string): Typed {
  const revenue = revenueOf(draft.lines);
  return {
    reference: draft.reference,
    reportDate: draft.reportDate || today,
    lines: draft.lines.map(lineDraftOf),
    fee: draft.fee ? feeDraftOf(draft.fee, revenue) : null,
    carried: draft.carried ? { label: draft.carried.label, amount: amountField(draft.carried.amountCents), fromReportId: draft.carried.fromReportId } : null,
    notes: draft.notes ?? "",
  };
}

/** A finished report's content as typed, for the read-only view and for a correction. */
export function fromReport(report: MonthlyReportView, today: string): Typed {
  const lines = report.legacy ? report.income.map(lineFromIncomeRow) : report.lines;
  return fromStored({ reference: report.reference, reportDate: report.reportDate, lines, fee: report.fee, carried: report.carried, notes: report.notes }, today);
}

/**
 * What a month starts from when nothing is stored for it: the reference
 * offered from the previous month's, today's date, no lines, the fee rate
 * offered from the previous statement or the property's default, no carried
 * balance, no notes. Nothing is saved until the admin types.
 */
export function suggestedTyped(previous: MonthlyReportView | null, management: PropertyManagementView | null, month: string, today: string): Typed {
  return {
    reference: referenceSuggestion(previous, month) ?? "",
    reportDate: today,
    lines: [],
    fee: freshFee(feeRateSuggestion(previous, management)),
    carried: null,
    notes: "",
  };
}

/** The fee as it stands: the base and the amount that follow the lines, filled in; the computed amount beside. */
export function feeNow(fee: FeeDraft, revenueCents: number): { rateBp: number | null; baseCents: number | null; computedCents: number | null; amountCents: number | null; label: string } {
  const rateBp = fee.rate.trim() === "" ? null : readRate(fee.rate);
  const baseText = fee.baseEdited ? readAmount(fee.base) : amountField(revenueCents);
  const baseCents = baseText === null || baseText.startsWith("-") ? null : centsOf(baseText);
  const computedCents = baseCents === null ? null : feeComputed(baseCents, rateBp);
  const amountText = fee.amountEdited ? readAmount(fee.amount) : computedCents === null ? null : amountField(computedCents);
  const amountCents = amountText === null || amountText.startsWith("-") ? null : centsOf(amountText);
  const label = fee.labelEdited ? fee.label : feeLabelFor(rateBp, baseCents ?? 0);
  return { rateBp, baseCents, computedCents, amountCents, label };
}

/** The typed draft as the writer and the server take it; a field that cannot be read is named. */
export function toDraft(typed: Typed): { lines: Line[]; fee: Fee | null; carried: Carried | null; problems: string[] } {
  const lines: Line[] = [];
  const problems: string[] = [];
  typed.lines.forEach((line, i) => {
    const rate = readAmount(line.rate);
    const quantity = readQuantity(line.quantity) ?? 0;
    const from = line.from.trim() || null;
    const to = line.to.trim() || null;
    if (line.description.trim() === "" || rate === null || rate === "0.00" || quantity < 1 || (from !== null && !isDayText(from)) || (to !== null && !isDayText(to)) || (from && to && to < from)) {
      problems.push(`Line ${i + 1}: ${line.description.trim() === "" ? "describe it" : rate === null || rate === "0.00" ? "check the rate" : quantity < 1 ? "the quantity is a whole number, 1 or more" : "check the dates"}`);
      return;
    }
    const rateCents = centsOf(rate);
    const out: Line = { id: line.id, description: line.description.trim(), from, to, quantity, rateCents, amountCents: lineAmount(quantity, rateCents) };
    if (line.details?.source !== undefined) out.source = line.details.source;
    if (line.details && "reference" in line.details) out.reference = line.details.reference ?? null;
    lines.push(out);
  });
  const revenue = revenueOf(lines);
  let fee: Fee | null = null;
  if (typed.fee) {
    const now = feeNow(typed.fee, revenue);
    if ((typed.fee.rate.trim() !== "" && now.rateBp === null) || now.baseCents === null || now.amountCents === null || now.label.trim() === "") {
      problems.push("Management fee: a rate in percent or an amount, a base, and a label");
    } else {
      fee = { label: now.label.trim(), rateBasisPoints: now.rateBp, baseCents: now.baseCents, computedCents: now.computedCents, amountCents: now.amountCents, overwritten: now.amountCents !== now.computedCents };
    }
  }
  let carried: Carried | null = null;
  if (typed.carried) {
    const amount = readAmount(typed.carried.amount);
    if (amount === null || typed.carried.label.trim() === "") problems.push("Carried balance: a label and an amount");
    else carried = { label: typed.carried.label.trim(), amountCents: centsOf(amount), fromReportId: typed.carried.fromReportId };
  }
  return { lines, fee, carried, problems };
}

/** The draft as the server saves it, whole, from what is typed. */
export function toPayload(propertyId: string, month: string, revision: number, typed: Typed, supersedes: { reportId: string; reason: string } | null): DraftPayload {
  const parsed = toDraft(typed);
  const revenue = revenueOf(parsed.lines);
  const fee = typed.fee ? feeNow(typed.fee, revenue) : null;
  return {
    propertyId,
    month,
    revision,
    reference: typed.reference.trim(),
    reportDate: typed.reportDate,
    lines: typed.lines.map((line): LinePayload => {
      const out: LinePayload = { id: line.id, description: line.description.trim(), from: line.from.trim() || null, to: line.to.trim() || null, quantity: readQuantity(line.quantity) ?? 1, rate: readAmount(line.rate) ?? line.rate };
      if (line.details?.source !== undefined) out.source = line.details.source;
      if (line.details && "reference" in line.details) out.reference = line.details.reference ?? null;
      return out;
    }),
    fee:
      typed.fee && fee
        ? {
            label: fee.label.trim(),
            rate: typed.fee.rate.trim() === "" ? null : typed.fee.rate.trim(),
            base: fee.baseCents === null ? (readAmount(typed.fee.base) ?? typed.fee.base) : amountField(fee.baseCents),
            amount: typed.fee.amountEdited || fee.rateBp === null ? (fee.amountCents === null ? (readAmount(typed.fee.amount) ?? typed.fee.amount) : amountField(fee.amountCents)) : null,
          }
        : null,
    carried: typed.carried ? { label: typed.carried.label.trim(), amount: readAmount(typed.carried.amount) ?? typed.carried.amount, fromReportId: typed.carried.fromReportId } : null,
    notes: typed.notes.trim() || null,
    supersedes,
  };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
