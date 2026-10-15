"use client";

/**
 * Direct payments' dialogs (part B of PROPERTY-LIST-COLUMNS-PLAN.md, Kian's rulings of 2026-10-15), shared by the
 * property page's Income tab and the Income page: record a payment received, start an arrangement or change one
 * (pause, resume, change its amount, end it), and set the months a payment pays. Every control is Nubnb's own (Kian's
 * ruling of 2026-10-10): no native select, date picker or confirm. Nothing here is optimistic: each dialog closes on
 * the server's answer and hands it back.
 */

import { useMemo, useState, type FormEvent } from "react";
import { AdminSelect } from "./AdminSelect";
import { DateRangeField } from "./DateRangeField";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import styles from "./DirectDialogs.module.css";
import { formatCents } from "@/app/lib/cleaners/model";
import { addMonths, monthLabel, monthOfDay } from "@/app/lib/reports/model";
import { earliestPaymentDay } from "@/app/lib/pay/model";
import {
  DIRECT_LIMITS,
  DIRECT_METHODS,
  DIRECT_METHOD_LABELS,
  DIRECT_PURPOSE_LABELS,
  ONE_OFF_PURPOSES,
  SHORT_STAY_WORDS,
  arrangementMonthRange,
  directLineText,
  dueDayWords,
  shortStayProblem,
  stayNights,
  type ArrangementView,
  type DirectMethod,
  type DirectPaymentView,
  type OneOffPurpose,
} from "@/app/lib/direct/model";
import { amountFor, arrangementMonths, isExpectedMonth } from "@/app/lib/direct/periods";
import { changeArrangement, recordDirectPayment, startArrangement, applyDirectPayment, type DirectResult } from "@/app/lib/direct-client";

/** "1200", "$1,200.5", "1200.00" → "1200.00"; null when it is not dollars and cents. */
export function amountText(typed: string): string | null {
  const match = /^\$?(\d{1,6})(?:\.(\d{1,2}))?$/.exec(typed.replace(/[\s,]/g, ""));
  return match ? `${Number(match[1])}.${(match[2] ?? "0").padEnd(2, "0")}` : null;
}
const centsOf = (text: string) => {
  const [dollars, cents] = text.split(".");
  return Number(dollars) * 100 + Number(cents);
};

/** The months an arrangement can be set in: 12 back to 12 ahead of today's, oldest first. */
function monthOptions(today: string, from?: string) {
  const { first, last } = arrangementMonthRange(today);
  const out: { value: string; label: string }[] = [];
  for (let m = from && from > first ? from : first; m <= last; m = addMonths(m, 1)) out.push({ value: m, label: monthLabel(m) });
  return out;
}

/** A failure as the dialog says it: a write that may or may not have landed says so. */
function failureWords(result: Extract<DirectResult<unknown>, { ok: false }>): string {
  return result.unknown ? `${result.title} It may or may not have been saved: close and reload before trying again.` : `${result.title}${result.detail ? ` ${result.detail}` : ""}`;
}

function Actions({ busy, label, onClose, disabled }: { busy: boolean; label: string; onClose: () => void; disabled?: boolean }) {
  return (
    <>
      <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
        Cancel
      </button>
      <button type="submit" form="direct-dialog-form" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy || disabled}>
        {busy ? "Saving…" : label}
      </button>
    </>
  );
}

// ─── Record a payment ──────────────────────────────────────────

export interface RecordPaymentDialogProps {
  /** The properties to choose from (the Income page); null when the property is fixed (its page). */
  /** Picked by the name the admin shows (`internalName`, Kian's rulings of 2026-10-15, evening), else the public title. */
  properties: { id: string; name: string; internalName?: string }[] | null;
  propertyId: string;
  /** Every arrangement the page holds: the chosen property's are offered. */
  arrangements: readonly ArrangementView[];
  payments: readonly DirectPaymentView[];
  today: string;
  /** The day the form starts on: today, or the month on screen's last day when that is earlier. */
  defaultDay: string;
  onClose: () => void;
  onRecorded: (payment: DirectPaymentView) => void;
}

export function RecordPaymentDialog(props: RecordPaymentDialogProps) {
  const [propertyId, setPropertyId] = useState(props.propertyId);
  const ofProperty = useMemo(() => props.arrangements.filter((a) => a.propertyId === propertyId), [props.arrangements, propertyId]);
  const [forWhat, setForWhat] = useState<string>(() => ofProperty.find((a) => a.untilMonth === null)?.id ?? ofProperty[0]?.id ?? "one-off");
  const arrangement = ofProperty.find((a) => a.id === forWhat) ?? null;
  const [purpose, setPurpose] = useState<OneOffPurpose>("not-a-stay");
  /** A one-off stay's first night and checkout day (Kian's rulings: 30 nights or more). */
  const [stay, setStay] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const stayProblem = !arrangement && purpose === "long-stay" ? (stay.from && stay.to ? shortStayProblem(stay) : "Give the stay its first night and its checkout day.") : null;
  const [payer, setPayer] = useState("");
  const [day, setDay] = useState(props.defaultDay);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<DirectMethod>("cash");
  const [wording, setWording] = useState(() => arrangement?.wording ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** What the arrangement is owed now, oldest month first: the months a payment would go to. */
  const owed = useMemo(() => {
    if (!arrangement) return null;
    const months = arrangementMonths(arrangement, props.payments as DirectPaymentView[], props.today);
    const open = months.periods.filter((p) => p.receivedCents < p.expectedCents).map((p) => ({ month: p.month, cents: p.expectedCents - p.receivedCents }));
    return { open, total: open.reduce((sum, p) => sum + p.cents, 0), credit: months.creditCents };
  }, [arrangement, props.payments, props.today]);

  const pick = (id: string) => {
    setForWhat(id);
    const next = ofProperty.find((a) => a.id === id);
    setWording(next ? next.wording : "");
  };
  const pickProperty = (id: string) => {
    setPropertyId(id);
    const first = props.arrangements.filter((a) => a.propertyId === id);
    const next = first.find((a) => a.untilMonth === null) ?? first[0] ?? null;
    setForWhat(next?.id ?? "one-off");
    setWording(next?.wording ?? "");
  };

  const text = amountText(amount);
  const shown = wording.trim() === "" ? null : directLineText({ method, wording: wording.trim().replace(/\s+/g, " "), day });

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (text === null || text === "0.00") return setError("Type the amount as dollars and cents, more than 0.00, like 1200.00.");
    if (wording.trim() === "") return setError("Say what the statement prints, like Monthly stay.");
    if (stayProblem) return setError(stayProblem);
    setBusy(true);
    setError(null);
    const result = await recordDirectPayment({
      propertyId,
      arrangementId: arrangement ? arrangement.id : null,
      purpose: arrangement ? null : purpose,
      payerName: arrangement ? null : payer.trim() === "" ? null : payer,
      stay: !arrangement && purpose === "long-stay" ? stay : null,
      day,
      amount: text,
      method,
      wording,
      note: note.trim() === "" ? null : note,
      appliesTo: null,
    });
    setBusy(false);
    if (!result.ok) return setError(failureWords(result));
    props.onRecorded(result.data.payment);
  };

  const forOptions = [...ofProperty.map((a) => ({ value: a.id, label: `${a.wording} · ${a.payerName}${a.untilMonth !== null ? ` · ended ${monthLabel(a.untilMonth)}` : ""}` })), { value: "one-off", label: "A one-off payment" }];

  return (
    <Dialog title="Record a payment received" onClose={props.onClose} initialFocus="none" actions={<Actions busy={busy} label="Record payment" onClose={props.onClose} />}>
      <form id="direct-dialog-form" className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fields}>
          {props.properties && (
            <div className={`${styles.field} ${styles.fieldFull}`}>
              <span className={styles.label}>Property</span>
              <AdminSelect label="Property" value={propertyId} onChange={pickProperty} searchable groups={[{ options: props.properties.map((p) => ({ value: p.id, label: p.internalName ?? p.name })) }]} disabled={busy} />
            </div>
          )}
          <div className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>For</span>
            <AdminSelect label="For" value={forWhat} onChange={pick} groups={[{ options: forOptions }]} disabled={busy} />
            {owed && <span className={styles.note}>{owed.total > 0 ? `Owed now ${formatCents(owed.total)}: ${owed.open.map((p) => `${monthLabel(p.month)} ${formatCents(p.cents)}`).join(" · ")}. It pays the oldest month first.` : owed.credit > 0 ? `Nothing owed now; ${formatCents(owed.credit)} waits for the next month.` : "Nothing owed now: it waits for the next month."}</span>}
          </div>
          {!arrangement && (
            <>
              <div className={styles.field}>
                <span className={styles.label}>What it is for</span>
                <AdminSelect label="What it is for" value={purpose} onChange={(v) => setPurpose(v as OneOffPurpose)} groups={[{ options: ONE_OFF_PURPOSES.map((p) => ({ value: p, label: DIRECT_PURPOSE_LABELS[p] })) }]} disabled={busy} />
                <span className={styles.note}>{SHORT_STAY_WORDS}</span>
              </div>
              {purpose === "long-stay" && (
                <div className={styles.field}>
                  <span className={styles.label}>The stay</span>
                  <DateRangeField label="The stay" from={stay.from} to={stay.to} onChange={(picked) => setStay({ from: picked.from, to: picked.to })} emptyText="First night – checkout" />
                  {stay.from && stay.to && stay.to > stay.from ? (
                    <span className={stayProblem ? styles.warn : styles.note}>{stayNights(stay)} nights{stayProblem ? `: under ${DIRECT_LIMITS.STAY_NIGHTS_MIN}, a short stay, not recorded` : ""}</span>
                  ) : null}
                </div>
              )}
              <label className={styles.field}>
                <span className={styles.label}>Who paid</span>
                <input className={styles.input} value={payer} maxLength={DIRECT_LIMITS.PAYER_MAX} placeholder="Optional · never printed" onChange={(e) => setPayer(e.target.value)} disabled={busy} />
              </label>
            </>
          )}
          <div className={styles.field}>
            <span className={styles.label}>Day received</span>
            <DateRangeField label="Day received" single from={day} to={day} max={props.today} min={earliestPaymentDay(props.today)} onChange={(picked) => setDay(picked.from)} />
          </div>
          <label className={`${styles.field} ${styles.fieldNarrow}`}>
            <span className={styles.label}>Amount ($)</span>
            <input className={`${styles.input} ${styles.amount}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
          </label>
          <div className={`${styles.field} ${styles.fieldNarrow}`}>
            <span className={styles.label}>Method</span>
            <AdminSelect label="Method" value={method} onChange={(v) => setMethod(v as DirectMethod)} groups={[{ options: DIRECT_METHODS.map((m) => ({ value: m, label: DIRECT_METHOD_LABELS[m] })) }]} disabled={busy} />
          </div>
          <label className={styles.field}>
            <span className={styles.label}>Statement wording</span>
            <input className={styles.input} value={wording} maxLength={DIRECT_LIMITS.WORDING_MAX} placeholder="Monthly stay" onChange={(e) => setWording(e.target.value)} disabled={busy} />
          </label>
          <label className={`${styles.field} ${styles.fieldFull}`}>
            <span className={styles.label}>Note</span>
            <input className={styles.input} value={note} maxLength={DIRECT_LIMITS.NOTE_MAX} placeholder="Optional" onChange={(e) => setNote(e.target.value)} disabled={busy} />
          </label>
        </div>
        {shown && <p className={styles.prints}>Prints: {shown}{text && text !== "0.00" ? ` · ${formatCents(centsOf(text))}` : ""}</p>}
        <p className={styles.note}>Received by you, and recorded under your name.</p>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

// ─── Start or change an arrangement ────────────────────────────

export type ArrangementDialogMode = { kind: "start"; propertyId: string } | { kind: "pause" | "resume" | "amount" | "end"; arrangement: ArrangementView };

const TITLES: Record<ArrangementDialogMode["kind"], string> = { start: "Set up direct payments", pause: "Pause the arrangement", resume: "Resume the arrangement", amount: "Change the amount", end: "End the arrangement" };

export function ArrangementDialog({ mode, today, onClose, onSaved }: { mode: ArrangementDialogMode; today: string; onClose: () => void; onSaved: (arrangement: ArrangementView) => void }) {
  const now = monthOfDay(today);
  const a = mode.kind === "start" ? null : mode.arrangement;
  const openPause = a && a.pauses.length > 0 && a.pauses[a.pauses.length - 1].until === null ? a.pauses[a.pauses.length - 1] : null;
  const defaultMonth = mode.kind === "start" ? now : mode.kind === "amount" ? addMonths(now, 1) : mode.kind === "resume" && openPause && openPause.from >= now ? addMonths(openPause.from, 1) : now;
  const [payer, setPayer] = useState("");
  const [wording, setWording] = useState("Monthly stay");
  const [amount, setAmount] = useState("");
  const [dueDay, setDueDay] = useState("1");
  const [month, setMonth] = useState(defaultMonth);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    const text = amountText(amount);
    if ((mode.kind === "start" || mode.kind === "amount") && (text === null || text === "0.00")) return setError("Type the amount as dollars and cents, more than 0.00, like 1200.00.");
    if (mode.kind === "start" && (payer.trim() === "" || wording.trim() === "")) return setError("Say who pays and what the statement prints.");
    setBusy(true);
    setError(null);
    const result =
      mode.kind === "start"
        ? await startArrangement({ propertyId: mode.propertyId, payerName: payer, wording, amount: text as string, dueDay: Number(dueDay), fromMonth: month })
        : mode.kind === "amount"
          ? await changeArrangement(mode.arrangement.id, mode.arrangement.history.length, { action: "amount", month, amount: text as string })
          : await changeArrangement(mode.arrangement.id, mode.arrangement.history.length, { action: mode.kind, month });
    setBusy(false);
    if (!result.ok) return setError(failureWords(result));
    onSaved(result.data.arrangement);
  };

  const label = mode.kind === "start" ? "Set up" : mode.kind === "pause" ? "Pause" : mode.kind === "resume" ? "Resume" : mode.kind === "amount" ? "Change amount" : "End";
  const monthLabelText = mode.kind === "end" ? "Last month expected" : mode.kind === "start" ? "First month expected" : "From";
  return (
    <Dialog title={a ? `${TITLES[mode.kind]}: ${a.wording} · ${a.payerName}` : TITLES[mode.kind]} onClose={onClose} initialFocus="none" actions={<Actions busy={busy} label={label} onClose={onClose} />}>
      <form id="direct-dialog-form" className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.fields}>
          {mode.kind === "start" && (
            <>
              <label className={styles.field}>
                <span className={styles.label}>Who pays</span>
                <input className={styles.input} value={payer} maxLength={DIRECT_LIMITS.PAYER_MAX} placeholder="A name · never printed" onChange={(e) => setPayer(e.target.value)} disabled={busy} autoFocus />
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Statement wording</span>
                <input className={styles.input} value={wording} maxLength={DIRECT_LIMITS.WORDING_MAX} onChange={(e) => setWording(e.target.value)} disabled={busy} />
              </label>
            </>
          )}
          {(mode.kind === "start" || mode.kind === "amount") && (
            <label className={`${styles.field} ${styles.fieldNarrow}`}>
              <span className={styles.label}>Amount per month ($)</span>
              <input className={`${styles.input} ${styles.amount}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={busy} />
            </label>
          )}
          {mode.kind === "start" && (
            <div className={`${styles.field} ${styles.fieldNarrow}`}>
              <span className={styles.label}>Due on</span>
              <AdminSelect label="Due on" value={dueDay} onChange={setDueDay} groups={[{ options: Array.from({ length: DIRECT_LIMITS.DUE_DAY_MAX }, (_, i) => ({ value: String(i + 1), label: dueDayWords(i + 1) })) }]} disabled={busy} />
            </div>
          )}
          <div className={styles.field}>
            <span className={styles.label}>{monthLabelText}</span>
            <AdminSelect label={monthLabelText} value={month} onChange={setMonth} groups={[{ options: monthOptions(today, a?.fromMonth) }]} disabled={busy} />
          </div>
        </div>
        {a && mode.kind === "amount" && <p className={styles.note}>Now {formatCents(amountFor(a, month))} a month in {monthLabel(month)}. Earlier months keep theirs.</p>}
        {a && mode.kind === "pause" && <p className={styles.note}>Nothing is expected from {monthLabel(month)} until it is resumed.</p>}
        {a && mode.kind === "end" && <p className={styles.note}>Nothing is expected after {monthLabel(month)}. Months not fully paid stay owed.</p>}
        {mode.kind === "start" && <p className={styles.note}>Monthly, due on {dueDayWords(Number(dueDay))}; overdue from the day after.</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

// ─── The months a payment pays ─────────────────────────────────

export function PaymentMonthsDialog({ payment, arrangement, payments, today, onClose, onSaved }: { payment: DirectPaymentView; arrangement: ArrangementView; payments: readonly DirectPaymentView[]; today: string; onClose: () => void; onSaved: (payment: DirectPaymentView) => void }) {
  const months = useMemo(() => arrangementMonths(arrangement, payments as DirectPaymentView[], today), [arrangement, payments, today]);
  const now = applied(months, payment.id);
  // The months it could pay: every month expected so far, and the next three expected.
  const choices = useMemo(() => {
    const list = months.periods.map((p) => p.month);
    for (let m = addMonths(monthOfDay(today), 1), i = 0; list.length < months.periods.length + 3 && i < 24; m = addMonths(m, 1), i += 1) if (isExpectedMonth(arrangement, m)) list.push(m);
    return list;
  }, [months, arrangement, today]);
  const [typed, setTyped] = useState<Record<string, string>>(() => Object.fromEntries(choices.map((m) => [m, now.get(m) ? (now.get(m)! / 100).toFixed(2) : ""])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parts = choices.map((m) => ({ month: m, text: typed[m]?.trim() ? amountText(typed[m]) : null, raw: typed[m]?.trim() ?? "" }));
  const sum = parts.reduce((s, p) => s + (p.text ? centsOf(p.text) : 0), 0);

  const save = async (auto: boolean) => {
    if (busy) return;
    if (!auto) {
      if (parts.some((p) => p.raw !== "" && p.text === null)) return setError("Type each amount as dollars and cents, like 600.00.");
      if (sum !== payment.amountCents) return setError(`The months add up to ${formatCents(sum)}; the payment is ${formatCents(payment.amountCents)}.`);
    }
    setBusy(true);
    setError(null);
    const appliesTo = auto ? null : parts.filter((p) => p.text && p.text !== "0.00").map((p) => ({ month: p.month, amount: p.text as string }));
    const result = await applyDirectPayment(payment.id, payment.history.length, appliesTo);
    setBusy(false);
    if (!result.ok) return setError(failureWords(result));
    onSaved(result.data.payment);
  };

  return (
    <Dialog
      title={`The months it pays: ${formatCents(payment.amountCents)} received ${payment.day}`}
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={() => void save(true)} disabled={busy}>
            Oldest unpaid first
          </button>
          <button type="submit" form="direct-dialog-form" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy}>
            {busy ? "Saving…" : "Save these months"}
          </button>
        </>
      }
    >
      <form
        id="direct-dialog-form"
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void save(false);
        }}
        noValidate
      >
        <div className={styles.months}>
          {choices.map((m) => {
            const period = months.periods.find((p) => p.month === m);
            return (
              <label key={m} style={{ display: "contents" }}>
                <span className={styles.monthName}>{monthLabel(m)}</span>
                <span className={styles.monthOwed}>{period ? `expects ${formatCents(period.expectedCents)}` : "later"}</span>
                <input className={`${styles.input} ${styles.amount}`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={typed[m] ?? ""} onChange={(e) => setTyped({ ...typed, [m]: e.target.value })} disabled={busy} />
              </label>
            );
          })}
        </div>
        <p className={styles.note}>
          {sum === payment.amountCents ? "Adds up to the payment." : `Adds up to ${formatCents(sum)} of ${formatCents(payment.amountCents)}.`} The statement is not changed: it prints the payment by the day received.
        </p>
        {error && <p className={styles.error} role="alert">{error}</p>}
      </form>
    </Dialog>
  );
}

/** How a payment is applied now, month by month (credit aside). */
function applied(months: ReturnType<typeof arrangementMonths>, paymentId: string): Map<string, number> {
  const parts = months.applied.get(paymentId)?.parts ?? [];
  return new Map(parts.map((p) => [p.month, p.cents]));
}
