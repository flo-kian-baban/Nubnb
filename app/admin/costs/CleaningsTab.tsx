"use client";

/**
 * Cleanings: a tab inside the Costs page (dispatch 37B, Kian's rulings of 2026-10-13).
 *
 * Admins log every cleaning by hand — the day cleaned, the property, the cleaner, the amount, an optional note — in
 * the form at the top, built to be fast: the day and the cleaner stay as they were after each cleaning, so a week of
 * one cleaner's cleanings is a property picked (typed into its search) and Log, a day changed when it changes. The
 * amount starts from what that cleaner was last paid for that property, or their default rate (set on the Team
 * page), and the admin changes it freely; the field says where it came from. Nothing is ticked from a list of
 * bookings here. A cleaning a cleaner marked on a job (the cleaning schedule, Kian's rulings of 2026-10-14) is linked
 * to it and reads "marked"; one marked with no amount to start from reads "No amount yet" until an admin types it.
 *
 * Under it, the cleanings in the Costs page's dates, property and cleaner, newest first: each can be changed, removed
 * (it stays, marked, and counts nowhere) or deleted while no finished statement prints it. A cleaning changed or
 * removed after a statement printed it is adjusted on the next month's statement; one logged for a month already
 * finished goes on the next open statement — the statements do it, and the answer to a log says which. With a
 * property chosen, each row says which statements charge it.
 *
 * The totals, and what each cleaner earned in those dates: a cleaning is also the cleaner's earnings record. Their
 * names are for admins: what an owner receives prints "Expense - Cleaning" and never names a cleaner.
 *
 * Every control is Nubnb's own (Kian's ruling of 2026-10-10): the day picker, the selects, the dialogs.
 */

import { useEffect, useMemo, useState, type FormEvent } from "react";
import Link from "next/link";
import { Sparkles } from "lucide-react";
import { AdminSelect } from "../components/AdminSelect";
import { DateRangeField } from "../components/DateRangeField";
import { useAsk } from "../components/AskDialog";
import type { Notice } from "../components/Notice";
import { changeCleaning, deleteCleaning, logCleaning, removeCleaning } from "@/app/lib/costs-client";
import { formatCents, type PropertyNameView } from "@/app/lib/cleaners/model";
import { amountField, cleanerNameOf, lastCleanerOf, readAmountCents, suggestedAmount, type CleaningView, type SuggestedFrom, type TeamRate } from "@/app/lib/cleanings/model";
import { RANGE_PRESETS, presetRange, shortDay } from "@/app/lib/costs/report";
import { chargesByMonth, type Charge } from "@/app/lib/money/month";
import { addMonths, monthLabel } from "@/app/lib/reports/model";
import p from "../property/page.module.css";
import styles from "./CleaningsTab.module.css";

interface Props {
  cleanings: CleaningView[];
  team: TeamRate[];
  properties: PropertyNameView[] | null;
  /** The Costs page's filters, shared: a property, a cleaner, and dates. */
  filters: { propertyId: string; cleanerId: string; from: string; to: string };
  setFilter: (change: Partial<{ propertyId: string; cleanerId: string; from: string; to: string }>) => void;
  /** Every statement that charges each of the chosen property's costs; null without a property, or until its statements are read. */
  charges: ReadonlyMap<string, Charge[]> | null;
  today: string;
  /** A cleaning the page opened from elsewhere (the costs list, the property page): its row is brought into view. */
  focusId: string | null;
  onSaved: (cleaning: CleaningView) => void;
  onDeleted: (id: string) => void;
  show: (notice: Notice) => void;
}

/** "$60.00", or, for a job's cleaning still waiting for one, "no amount yet". */
const amountWords = (cents: number | null) => (cents === null ? "no amount yet" : formatCents(cents));

/** What removing or deleting a job's cleaning does to the job (Kian's ruling of 2026-10-14, night). */
const JOB_MARK_KEPT = "Its job keeps the cleaner's mark as removed by the office: they cannot mark it again until it is reopened on the Schedule.";

const SOURCE_WORDS: Record<SuggestedFrom, string> = {
  last: "last paid for this property",
  default: "their default rate",
  none: "type the amount",
};

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

interface Editing {
  id: string;
  day: string;
  cleanerId: string;
  amount: string;
  note: string;
  reason: string;
}

export function CleaningsTab({ cleanings, team, properties, filters, setFilter, charges, today, focusId, onSaved, onDeleted, show }: Props) {
  const { ask, dialog } = useAsk();
  const names = useMemo(() => new Map((properties ?? []).map((property) => [property.id, property.name?.trim() || "Unnamed property"])), [properties]);
  const nameOf = (c: Pick<CleaningView, "propertyId" | "propertyNameAtEntry" | "property">) => c.property.name?.trim() || names.get(c.propertyId) || c.propertyNameAtEntry || "Unknown property";
  /** Who can be picked: active cleaners, not handymen. */
  const pickable = useMemo(() => team.filter((member) => member.role === "cleaner" && member.status === "active"), [team]);
  const rateOf = (cleanerId: string) => team.find((member) => member.id === cleanerId)?.defaultRateCents ?? null;

  // ── The form ──
  const [day, setDay] = useState(today);
  const [propertyId, setPropertyId] = useState(filters.propertyId);
  const [cleanerId, setCleanerId] = useState("");
  const [amount, setAmount] = useState("");
  const [from, setFrom] = useState<SuggestedFrom>("none");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);

  /** The amount starts from the cleaner's last amount for the property, else their default rate (Kian's ruling). */
  const prefill = (nextProperty: string, nextCleaner: string) => {
    if (nextProperty === "" || nextCleaner === "") {
      setAmount("");
      setFrom("none");
      return;
    }
    const suggestion = suggestedAmount(cleanings, nextCleaner, nextProperty, rateOf(nextCleaner));
    setAmount(suggestion.cents === null ? "" : amountField(suggestion.cents));
    setFrom(suggestion.from);
  };
  const pickProperty = (id: string) => {
    setPropertyId(id);
    // No cleaner chosen yet: whoever cleaned the property last, when they can still be picked.
    const last = cleanerId === "" ? lastCleanerOf(cleanings, id) : null;
    const next = last !== null && pickable.some((member) => member.id === last) ? last : cleanerId;
    if (next !== cleanerId) setCleanerId(next);
    prefill(id, next);
  };
  const pickCleaner = (id: string) => {
    setCleanerId(id);
    prefill(propertyId, id);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const cents = readAmountCents(amount);
    const problems = [
      day === "" ? "Pick the day it was cleaned." : null,
      propertyId === "" ? "Pick the property." : null,
      cleanerId === "" ? "Pick the cleaner." : null,
      cents === null ? "Type the amount: dollars and cents above $0.00, like 60.00." : null,
    ].filter((problem): problem is string => problem !== null);
    if (problems.length > 0 || cents === null) {
      show({ tone: "error", title: "The cleaning was not logged.", items: problems });
      return;
    }
    setSaving(true);
    const result = await logCleaning({ propertyId, cleanerId, day, amount: amountField(cents), note: note.trim() === "" ? null : note.trim() });
    setSaving(false);
    if (!result.ok) {
      show(
        result.unknown
          ? { tone: "warning", title: "The cleaning may or may not have been logged. Refresh before logging it again.", detail: result.title }
          : { tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") || undefined },
      );
      return;
    }
    const { cleaning, statementMonth } = result.data;
    onSaved(cleaning);
    const month = cleaning.day.slice(0, 7);
    show({
      tone: statementMonth === month ? "success" : "info",
      title: `Logged ${amountWords(cleaning.amountCents)} · ${nameOf(cleaning)} · ${shortDay(cleaning.day)} (${cleanerNameOf(cleaning)}).`,
      detail: statementMonth === month ? `It goes on ${monthLabel(month)}'s statement.` : `${monthLabel(month)} is finished: it goes on ${monthLabel(statementMonth)}'s statement.`,
    });
    // Ready for the next one: the same day and cleaner, another property.
    setPropertyId("");
    setNote("");
    setAmount("");
    setFrom("none");
  };

  // ── The list ──
  const shown = useMemo(
    () =>
      cleanings
        .filter((c) => (filters.propertyId === "" || c.propertyId === filters.propertyId) && (filters.cleanerId === "" || c.cleanerId === filters.cleanerId) && (filters.from === "" || c.day >= filters.from) && (filters.to === "" || c.day <= filters.to))
        .sort((a, b) => b.day.localeCompare(a.day) || b.createdAt.localeCompare(a.createdAt)),
    [cleanings, filters],
  );
  const logged = useMemo(() => shown.filter((c) => c.status === "logged"), [shown]);
  const total = useMemo(() => logged.reduce((sum, c) => sum + (c.amountCents ?? 0), 0), [logged]);
  /** Cleanings marked on a job with no amount to start from (the cleaning schedule): each waits for an admin to type one. */
  const waiting = useMemo(() => logged.filter((c) => c.amountCents === null).length, [logged]);
  /**
   * What each cleaner earned in these dates (Kian's ruling: a cleaning is also the cleaner's earnings record), and
   * beside the total, how many of their cleanings are still waiting for an amount (Kian, 2026-10-14, night).
   */
  const earned = useMemo(() => {
    const byCleaner = new Map<string, { name: string; count: number; cents: number; waiting: number }>();
    for (const c of logged) {
      const was = byCleaner.get(c.cleanerId) ?? { name: cleanerNameOf(c) + (c.cleaner.state === "missing" ? " (deleted)" : ""), count: 0, cents: 0, waiting: 0 };
      byCleaner.set(c.cleanerId, { ...was, count: was.count + 1, cents: was.cents + (c.amountCents ?? 0), waiting: was.waiting + (c.amountCents === null ? 1 : 0) });
    }
    return [...byCleaner.values()].sort((a, b) => a.name.localeCompare(b.name, "en-CA"));
  }, [logged]);

  useEffect(() => {
    if (focusId === null) return;
    requestAnimationFrame(() => document.getElementById(`cleaning-${focusId}`)?.scrollIntoView({ block: "center" }));
  }, [focusId]);

  /** Where a cleaning is charged, in words, with a property chosen: its statements and their parts. */
  const chargedWords = (c: CleaningView): string | null => {
    if (charges === null) return null;
    const parts = chargesByMonth(charges.get(c.id) ?? []);
    if (parts.length === 0) return c.status === "logged" ? "on no statement yet" : null;
    return parts.map((part) => `${monthLabel(part.month)}${part.finished ? "" : " (open)"} ${formatCents(part.cents)}`).join(" · ");
  };

  // ── Change, remove, delete ──
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const startEditing = (c: CleaningView) => setEditing({ id: c.id, day: c.day, cleanerId: c.cleanerId, amount: c.amountCents === null ? "" : amountField(c.amountCents), note: c.note ?? "", reason: "" });

  const failed = (result: { title: string; detail?: string; unknown: boolean; status: number }, what: string) =>
    show(result.unknown ? { tone: "warning", title: `The cleaning may or may not have been ${what}. Refresh to see what is on record.`, detail: result.title } : { tone: "error", title: result.title, detail: [result.detail, result.status === 401 || result.status === 403 ? SESSION_HINT : null].filter(Boolean).join(" ") || undefined });

  const saveEditing = async (c: CleaningView) => {
    if (!editing || busy) return;
    const cents = readAmountCents(editing.amount);
    if (cents === null) {
      show({ tone: "error", title: "Type the amount: dollars and cents above $0.00, like 60.00." });
      return;
    }
    setBusy(c.id);
    const result = await changeCleaning(c.id, {
      seen: c.history.length,
      ...(editing.day !== c.day ? { day: editing.day } : {}),
      ...(cents !== c.amountCents ? { amount: amountField(cents) } : {}),
      ...(editing.cleanerId !== c.cleanerId ? { cleanerId: editing.cleanerId } : {}),
      ...((editing.note.trim() || null) !== c.note ? { note: editing.note.trim() || null } : {}),
      reason: editing.reason.trim() || null,
    });
    setBusy(null);
    if (!result.ok) {
      failed(result, "saved");
      return;
    }
    setEditing(null);
    if (!result.data.changed) {
      show({ tone: "info", title: "Nothing changed." });
      return;
    }
    // The page reads the cleaning again with its lookups on the next refresh; the stored fields are these.
    onSaved({ ...result.data.cleaning, cleaner: { ...c.cleaner, name: result.data.cleaning.cleanerId === c.cleanerId ? c.cleaner.name : result.data.cleaning.cleanerNameAtEntry }, property: c.property });
    show({ tone: "success", title: `Saved the cleaning of ${shortDay(result.data.cleaning.day)}.`, detail: `Its statement: ${monthLabel(result.data.statementMonth)}'s. A change after a statement printed it shows on the next month's.` });
  };

  const remove = async (c: CleaningView) => {
    if (busy) return;
    const yes = await ask({
      title: `Remove the cleaning of ${shortDay(c.day)}?`,
      lines: [`${nameOf(c)} · ${cleanerNameOf(c)} · ${amountWords(c.amountCents)}.`, "It stays, marked, and counts nowhere. If a finished statement printed it, the next open statement gives it back.", c.jobId !== null ? JOB_MARK_KEPT : null],
      confirm: "Remove",
    });
    if (!yes) return;
    setBusy(c.id);
    const result = await removeCleaning(c.id, { seen: c.history.length });
    setBusy(null);
    if (!result.ok) {
      failed(result, "removed");
      return;
    }
    onSaved({ ...result.data.cleaning, cleaner: c.cleaner, property: c.property });
    show({ tone: "success", title: `Removed the cleaning of ${shortDay(c.day)}.` });
  };

  const erase = async (c: CleaningView) => {
    if (busy) return;
    const yes = await ask({
      title: `Delete the cleaning of ${shortDay(c.day)}?`,
      lines: [`${nameOf(c)} · ${cleanerNameOf(c)} · ${amountWords(c.amountCents)}.`, `It is deleted for good: no record is left of who cleaned or what they were paid. A cleaning a finished statement prints cannot be deleted${c.status === "logged" ? ": remove it instead" : ""}.`, c.jobId !== null ? JOB_MARK_KEPT : null],
      confirm: "Delete",
      danger: true,
    });
    if (!yes) return;
    setBusy(c.id);
    const result = await deleteCleaning(c.id, { seen: c.history.length });
    setBusy(null);
    if (!result.ok) {
      failed(result, "deleted");
      return;
    }
    onDeleted(c.id);
    show({ tone: "success", title: `Deleted the cleaning of ${shortDay(c.day)}.` });
  };

  const propertyOptions = [...names.entries()].sort((a, b) => a[1].localeCompare(b[1], "en-CA")).map(([id, name]) => ({ value: id, label: name }));
  const cleanerOptions = pickable.map((member) => ({ value: member.id, label: member.name?.trim() || "Unnamed cleaner" }));
  const dayPresets = [
    { key: "today", label: "Today", from: today, to: today },
    { key: "yesterday", label: "Yesterday", ...(() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); const y = d.toISOString().slice(0, 10); return { from: y, to: y }; })() },
  ];
  /** Every cleaner a cleaning names, for the filter: the team's, and a deleted one by the name it was logged with. */
  const filterCleaners = useMemo(() => {
    const byId = new Map<string, string>();
    for (const member of team.filter((m) => m.role === "cleaner")) byId.set(member.id, member.name?.trim() || "Unnamed cleaner");
    for (const c of cleanings) if (!byId.has(c.cleanerId)) byId.set(c.cleanerId, `${cleanerNameOf(c)} (deleted)`);
    return [...byId.entries()].sort((a, b) => a[1].localeCompare(b[1], "en-CA"));
  }, [team, cleanings]);

  return (
    <section className={p.block} aria-label="Cleanings">
      {/* ── Log a cleaning ── */}
      <form className={p.form} onSubmit={submit} aria-label="Log a cleaning">
        <p className={p.formTitle}>Log a cleaning</p>
        <div className={p.fields}>
          <div className={`${p.field} ${styles.fieldDay}`}>
            <span className={p.fieldLabel}>Day cleaned</span>
            <DateRangeField label="Day cleaned" single from={day} to={day} max={today} min={`${addMonths(today.slice(0, 7), -12)}-01`} presets={dayPresets} onChange={(range) => setDay(range.from)} />
          </div>
          <div className={`${p.field} ${p.fieldGrow}`}>
            <span className={p.fieldLabel}>Property</span>
            <AdminSelect label="Property" className={styles.selectFull} value={propertyId} onChange={pickProperty} placeholder="Pick the property" searchable groups={[{ options: propertyOptions }]} disabled={saving} />
          </div>
          <div className={`${p.field} ${styles.fieldCleaner}`}>
            <span className={p.fieldLabel}>Cleaner</span>
            <AdminSelect label="Cleaner" className={styles.selectFull} value={cleanerId} onChange={pickCleaner} placeholder={cleanerOptions.length === 0 ? "No active cleaner" : "Pick the cleaner"} groups={[{ options: cleanerOptions }]} disabled={saving || cleanerOptions.length === 0} />
          </div>
          <label className={`${p.field} ${styles.fieldAmountShort}`}>
            <span className={p.fieldLabel}>Amount ($)</span>
            <input className={`${p.textInput} ${p.amountInput}`} inputMode="decimal" placeholder="60.00" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={saving} />
            {propertyId !== "" && cleanerId !== "" && <span className={p.note}>{SOURCE_WORDS[from]}</span>}
          </label>
          <label className={`${p.field} ${p.fieldGrow}`}>
            <span className={p.fieldLabel}>Note (optional)</span>
            <input className={p.textInput} value={note} maxLength={300} placeholder="Mid-stay clean" onChange={(e) => setNote(e.target.value)} disabled={saving} />
          </label>
        </div>
        <div className={p.formActions}>
          <button type="submit" className={p.btnPrimary} disabled={saving}>
            <Sparkles size={15} aria-hidden />
            <span>{saving ? "Logging…" : "Log cleaning"}</span>
          </button>
          {pickable.length > 0 && pickable.every((member) => member.defaultRateCents === null) && <span className={p.note}>No cleaner has a default rate yet: set one on the Team page.</span>}
        </div>
      </form>

      {/* ── The cleanings in these dates ── */}
      <div className={`${p.blockHead} ${styles.listHead}`}>
        <h3 className={p.blockTitle}>Cleanings</h3>
        <span className={p.blockTotal}>{logged.length === 0 ? "None" : `${logged.length === 1 ? "1 cleaning" : `${logged.length} cleanings`} · ${formatCents(total)}${waiting > 0 ? ` · ${waiting} waiting for an amount` : ""}`}</span>
      </div>
      <div className={`${p.fields} ${styles.filters}`}>
        <div className={`${p.field} ${p.fieldDates}`}>
          <DateRangeField label="Dates" from={filters.from} to={filters.to} max={today} onChange={(range) => setFilter(range)} presets={RANGE_PRESETS.map((preset) => ({ ...preset, ...presetRange(preset.key, today) }))} note="By the day cleaned." />
        </div>
        <div className={`${p.field} ${p.fieldGrow}`}>
          <AdminSelect label="Property" className={styles.selectFull} value={filters.propertyId} onChange={(id) => setFilter({ propertyId: id })} searchable groups={[{ options: [{ value: "", label: "Every property" }, ...propertyOptions] }]} />
        </div>
        <div className={`${p.field} ${styles.fieldCleaner}`}>
          <AdminSelect label="Cleaner" className={styles.selectFull} value={filters.cleanerId} onChange={(id) => setFilter({ cleanerId: id })} groups={[{ options: [{ value: "", label: "Every cleaner" }, ...filterCleaners.map(([id, name]) => ({ value: id, label: name }))] }]} />
        </div>
      </div>

      {shown.length === 0 ? (
        <p className={p.note}>No cleaning in these dates{filters.propertyId || filters.cleanerId ? " for this choice" : ""}.</p>
      ) : (
        <table className={p.listTable}>
          <thead>
            <tr>
              <th>Day</th>
              <th>Property</th>
              <th>Cleaner</th>
              <th className={p.num}>Amount</th>
              <th>Note</th>
              {charges !== null && <th>Charged on</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((c) =>
              editing?.id === c.id ? (
                <tr key={c.id} id={`cleaning-${c.id}`} className={styles.editRow}>
                  <td colSpan={charges !== null ? 7 : 6}>
                    <div className={p.fields}>
                      <div className={`${p.field} ${styles.fieldDay}`}>
                        <span className={p.fieldLabel}>Day cleaned</span>
                        <DateRangeField label="Day cleaned" single from={editing.day} to={editing.day} max={today} onChange={(range) => setEditing({ ...editing, day: range.from })} />
                      </div>
                      <div className={`${p.field} ${styles.fieldCleaner}`}>
                        <span className={p.fieldLabel}>Cleaner</span>
                        <AdminSelect label="Cleaner" value={editing.cleanerId} onChange={(id) => setEditing({ ...editing, cleanerId: id })} groups={[{ options: [...team.filter((m) => m.role === "cleaner" && (m.status === "active" || m.id === c.cleanerId)).map((m) => ({ value: m.id, label: m.name?.trim() || "Unnamed cleaner" })), ...(team.some((m) => m.id === c.cleanerId) ? [] : [{ value: c.cleanerId, label: `${cleanerNameOf(c)} (deleted)` }])] }]} />
                      </div>
                      <label className={`${p.field} ${styles.fieldAmountShort}`}>
                        <span className={p.fieldLabel}>Amount ($)</span>
                        <input className={`${p.textInput} ${p.amountInput}`} inputMode="decimal" value={editing.amount} onChange={(e) => setEditing({ ...editing, amount: e.target.value })} />
                      </label>
                      <label className={`${p.field} ${p.fieldGrow}`}>
                        <span className={p.fieldLabel}>Note</span>
                        <input className={p.textInput} value={editing.note} maxLength={300} onChange={(e) => setEditing({ ...editing, note: e.target.value })} />
                      </label>
                      <label className={`${p.field} ${p.fieldGrow}`}>
                        <span className={p.fieldLabel}>Why (optional, kept in its history)</span>
                        <input className={p.textInput} value={editing.reason} maxLength={300} onChange={(e) => setEditing({ ...editing, reason: e.target.value })} />
                      </label>
                    </div>
                    <div className={p.formActions}>
                      <button type="button" className={p.btnPrimary} disabled={busy !== null} onClick={() => void saveEditing(c)}>
                        {busy === c.id ? "Saving…" : "Save"}
                      </button>
                      <button type="button" className={p.btnGhost} disabled={busy !== null} onClick={() => setEditing(null)}>
                        Cancel
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={c.id} id={`cleaning-${c.id}`} className={`${c.status === "removed" ? styles.removed : ""} ${c.id === focusId ? styles.focused : ""}`}>
                  <td className={styles.nowrap}>{shortDay(c.day)}</td>
                  <td>
                    <Link href={`/admin/property?id=${encodeURIComponent(c.propertyId)}&month=${c.day.slice(0, 7)}&tab=costs`} prefetch={false} className={p.linkButton}>
                      {nameOf(c)}
                    </Link>
                  </td>
                  <td>
                    {cleanerNameOf(c)}
                    {c.cleaner.state === "missing" && <span className={p.note}> (deleted)</span>}
                  </td>
                  <td className={p.num}>
                    {c.amountCents === null ? (
                      <span className={`${p.costMark} ${p.costMarkWarn}`} title="Marked cleaned on a job with no amount to start from: type it with Change">
                        No amount yet
                      </span>
                    ) : c.status === "removed" ? (
                      <span className={styles.struck}>{formatCents(c.amountCents)}</span>
                    ) : (
                      formatCents(c.amountCents)
                    )}
                    {c.status === "removed" && <span className={`${p.costMark} ${p.costMarkWarn}`}>removed</span>}
                    {c.jobId !== null && <span className={p.note} title="Made by the cleaner's Mark cleaned on a job, dated its checkout day"> · marked</span>}
                  </td>
                  <td className={styles.noteCell}>{c.note ?? ""}</td>
                  {charges !== null && <td className={styles.chargedCell}>{chargedWords(c)}</td>}
                  <td>
                    {/* A removed cleaning can still be deleted outright, as a removed cost entry can (dispatch 23H). */}
                    <span className={styles.rowActions}>
                      {c.status === "logged" && (
                        <>
                          <button type="button" className={`${p.btnGhost} ${p.btnSmall}`} disabled={busy !== null || editing !== null} onClick={() => startEditing(c)}>
                            Change
                          </button>
                          <button type="button" className={`${p.btnGhost} ${p.btnSmall}`} disabled={busy !== null || editing !== null} onClick={() => void remove(c)}>
                            Remove
                          </button>
                        </>
                      )}
                      <button type="button" className={`${p.btnGhost} ${p.btnSmall}`} disabled={busy !== null || editing !== null} onClick={() => void erase(c)}>
                        Delete
                      </button>
                    </span>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      )}

      {earned.length > 0 && (
        <div className={styles.earned} aria-label="Earned">
          <span className={p.fieldLabel}>Earned in these dates</span>
          <span>{earned.map((row) => `${row.name} · ${row.count === 1 ? "1 cleaning" : `${row.count} cleanings`} · ${formatCents(row.cents)}${row.waiting > 0 ? ` · ${row.waiting} waiting for an amount` : ""}`).join("   ·   ")}</span>
        </div>
      )}
      {dialog}
    </section>
  );
}
