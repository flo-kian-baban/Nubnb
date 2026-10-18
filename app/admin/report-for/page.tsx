"use client";

/**
 * The Report For sheet (2026-10-17, build round 1 of the property page audit): one table of every property, with
 * its Report For name and address, its reference stem (Kian's ruling K5: a new statement's reference is suggested as
 * "<Mon>-<stem>") and its default fee rate (K6), each typed in place.
 *
 * A row saves itself 800 ms after the last change, and at once when the cursor leaves it, through the management
 * route (PUT /api/admin/properties/[id]/management) with its three fields alone: every other field of the record —
 * owners, the months statements run, excluded from reporting — keeps what is stored, read and written in one
 * transaction. A row that cannot be saved says why in one line and sends nothing.
 *
 * "Owes a statement" narrows the table to the properties with a statement owed now (the home's rule, `owedMonths`
 * over `reportingStatus`); a blocked one — owed, with no Report For name, the one thing Finish refuses — is marked.
 * Reached from the home's "Statements blocked" chip (?owes=1) and from the property page. The filter and the search
 * are kept in the address.
 *
 * One read: the statements tracker (GET /api/admin/monthly-reports), the home's, which holds every property's
 * names, created month and months with money, every management record and every finished statement.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, RefreshCw, Search, X } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { PinGate } from "../components/PinGate";
import { ReportingStatusCell } from "../components/StatementStatus";
import { fetchTracker, type TrackerData } from "@/app/lib/reports-client";
import { setManagementFields } from "@/app/lib/firebase/properties";
import { torontoDayOf } from "@/app/lib/costs/report";
import { monthLabel, monthOfDay, referenceFromStem, stemProblem, STATEMENT_LIMITS, type PropertyManagementView } from "@/app/lib/reports/model";
import { reportingStatuses, type ReportingStatus } from "@/app/lib/reports/statement";
import { reportForCut } from "@/app/lib/reports/statement-pdf";
import { owedMonths } from "@/app/lib/home/next-step";
import { sameSheetRow, sheetFieldsOf, sheetPayload, sheetProblem, type SheetFields } from "@/app/lib/reports/report-for-sheet";
import shared from "../page.module.css";
import form from "../property/page.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };

/** Accents and case set aside, as the home's search does. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

export default function ReportForPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <Sheet />
      </Suspense>
    </PinGate>
  );
}

function Sheet() {
  const params = useSearchParams();
  const [owesOnly, setOwesOnly] = useState(() => params.get("owes") === "1");
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [tracker, setTracker] = useState<Read<TrackerData>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** Each property's record as the server last answered it: the tracker's, then each row's saves. */
  const [records, setRecords] = useState<Map<string, PropertyManagementView>>(new Map());
  const today = torontoDayOf(new Date());

  useEffect(() => {
    let cancelled = false;
    fetchTracker().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setTracker({ kind: "ready", data: result.data });
        setRecords(new Map(result.data.management.map((record) => [record.propertyId, record])));
      } else {
        setTracker({ kind: "error", title: result.title, detail: result.detail, status: result.status });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // The filter and the search, kept in the address (?owes=1&q=).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (owesOnly) url.searchParams.set("owes", "1");
    else url.searchParams.delete("owes");
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    if (url.href !== window.location.href) window.history.replaceState(null, "", url.href);
  }, [owesOnly, query]);

  const data = tracker.kind === "ready" ? tracker.data : null;
  /** Every property's standing, by the one rule (`reportingStatus`), over the records as they now stand. */
  const statuses = useMemo(() => {
    if (!data) return null;
    return reportingStatuses({
      today,
      properties: data.properties.map((p) => ({ id: p.id, createdMonth: p.createdMonth ?? null, moneyMonths: p.moneyMonths ?? [] })),
      management: [...records.values()],
      reports: data.reports,
    });
  }, [data, records, today]);

  const rows = useMemo(() => {
    if (!data || !statuses) return [];
    return data.properties
      .map((p) => {
        const name = p.internalName?.trim() || p.name?.trim() || "Unnamed property";
        const status = statuses.get(p.id) ?? null;
        return { id: p.id, name, publicName: p.name?.trim() && p.name.trim() !== name ? p.name.trim() : null, status, owed: status ? owedMonths(status) : [] };
      })
      .sort((a, b) => a.name.localeCompare(b.name, "en-CA"));
  }, [data, statuses]);
  const owing = rows.filter((row) => row.owed.length > 0);
  const blockedCount = owing.filter((row) => (records.get(row.id)?.reportFor?.name ?? "").trim() === "").length;
  const shown = rows.filter((row) => (!owesOnly || row.owed.length > 0) && (query.trim() === "" || fold(`${row.name} ${row.publicName ?? ""}`).includes(fold(query.trim()))));

  const onSaved = useCallback((record: PropertyManagementView) => {
    setRecords((prev) => new Map(prev).set(record.propertyId, record));
  }, []);

  return (
    <div className={shared.container}>
      <AdminHeader current="properties" title="Report For" />
      <main className={shared.main}>
        <PageHead title="Report For">
          <button type="button" className={shared.btnGhost} onClick={() => setAttempt((n) => n + 1)} disabled={tracker.kind === "loading"}>
            <RefreshCw size={15} aria-hidden />
            <span>Refresh</span>
          </button>
        </PageHead>

        {tracker.kind === "error" ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the properties</h2>
            <p>
              Nothing here is shown until they load.
              {(tracker.status === 401 || tracker.status === 403) && " Your admin session may have expired — reload and sign in again."}
            </p>
            <code className={shared.loadErrorDetail}>
              {tracker.title}
              {tracker.detail ? ` ${tracker.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={() => setAttempt((n) => n + 1)}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : tracker.kind === "loading" || !statuses ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading the properties…</p>
          </div>
        ) : (
          <>
            <section className={shared.toolbar} aria-label="Search and filter">
              <div className={shared.toolbarRow}>
                <div className={shared.searchWrapper}>
                  <Search size={16} className={shared.searchIcon} aria-hidden />
                  <input type="search" className={shared.searchInput} placeholder="Search by address or title" aria-label="Search properties by address or title" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setQuery("")} autoComplete="off" spellCheck={false} />
                  {query && (
                    <button type="button" className={shared.searchClear} aria-label="Clear search" onClick={() => setQuery("")}>
                      <X size={14} aria-hidden />
                    </button>
                  )}
                </div>
                <div className={shared.chipRow} role="group" aria-label="Show only">
                  <button type="button" className={`${shared.filterChip} ${owesOnly ? shared.filterChipOn : ""}`} aria-pressed={owesOnly} onClick={() => setOwesOnly((on) => !on)}>
                    <span>Owes a statement</span>
                    <span className={shared.chipCount}>{owing.length}</span>
                  </button>
                  <span className={styles.summary}>{blockedCount === 0 ? "None blocked" : `${blockedCount} blocked: no Report For name`}</span>
                </div>
              </div>
            </section>

            {shown.length === 0 ? (
              <div className={shared.empty}>
                <Search size={48} strokeWidth={1} />
                <h2>No matching properties</h2>
                <p>Nothing matches. Try fewer words, or show every property.</p>
              </div>
            ) : (
              <div className={`${shared.tableContainer} ${shared.tableScroll}`}>
                <table className={`${shared.table} ${styles.sheet}`}>
                  <colgroup>
                    <col className={styles.colProperty} />
                    <col className={styles.colStatement} />
                    <col className={styles.colName} />
                    <col className={styles.colAddress} />
                    <col className={styles.colStem} />
                    <col className={styles.colRate} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-live="polite">{shown.length === rows.length ? `${rows.length} units` : `${shown.length} of ${rows.length} units`}</th>
                      <th>Statement</th>
                      <th>Report For name</th>
                      <th>Address</th>
                      <th title="The reference less its month: a new statement starts as <Mon>-<stem>">Reference stem</th>
                      <th title="What a new statement's fee starts from">Fee rate (%)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      // Keyed by the read too: Refresh shows each row as the server now holds it.
                      <SheetRow key={`${row.id}:${attempt}`} propertyId={row.id} name={row.name} publicName={row.publicName} status={row.status} owed={row.owed} record={records.get(row.id) ?? null} today={today} onSaved={onSaved} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

type RowState = { kind: "idle" } | { kind: "unsaved" } | { kind: "saving" } | { kind: "saved" } | { kind: "invalid"; problem: string } | { kind: "failed"; reason: string };

interface RowProps {
  propertyId: string;
  name: string;
  publicName: string | null;
  status: ReportingStatus | null;
  owed: string[];
  /** The record as the server last answered it. */
  record: PropertyManagementView | null;
  today: string;
  onSaved: (record: PropertyManagementView) => void;
}

/** One property: its four fields, typed in place, saved 800 ms after the last change and when the cursor leaves the row. */
function SheetRow({ propertyId, name, publicName, status, owed, record, today, onSaved }: RowProps) {
  const [typed, setTyped] = useState<SheetFields>(() => sheetFieldsOf(record));
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const typedRef = useRef(typed);
  typedRef.current = typed;
  /** What the server holds for the row's three fields. */
  const storedRef = useRef<SheetFields>(sheetFieldsOf(record));
  const timer = useRef<number | null>(null);
  const sending = useRef(false);
  const again = useRef(false);

  /** Send what is typed until what is stored matches it: one save at a time; a change made while one is out is sent after it. */
  const save = useCallback(async () => {
    if (sending.current) {
      again.current = true;
      return;
    }
    sending.current = true;
    try {
      do {
        again.current = false;
        const current = typedRef.current;
        if (sameSheetRow(current, storedRef.current)) {
          setState((was) => (was.kind === "unsaved" || was.kind === "invalid" || was.kind === "saving" ? { kind: "saved" } : was));
          continue;
        }
        const problem = sheetProblem(current);
        if (problem) {
          setState({ kind: "invalid", problem });
          continue;
        }
        setState({ kind: "saving" });
        const result = await setManagementFields(propertyId, sheetPayload(current));
        if (result.ok) {
          storedRef.current = sheetFieldsOf(result.data.record);
          onSaved(result.data.record);
          setState(sameSheetRow(typedRef.current, storedRef.current) ? { kind: "saved" } : { kind: "unsaved" });
        } else {
          const issue = result.issues[0]?.message;
          setState({ kind: "failed", reason: issue ? `${result.error}: ${issue}` : result.status === 401 || result.status === 403 ? `${result.error}. Your admin session may have expired — reload and sign in again.` : result.error });
        }
      } while (again.current);
    } finally {
      sending.current = false;
    }
  }, [propertyId, onSaved]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      void save();
    }
  }, [save]);
  // A save still waiting when the page is left is sent, not lost.
  useEffect(() => () => flush(), [flush]);

  const change = (patch: Partial<SheetFields>) => {
    setTyped((was) => ({ ...was, ...patch }));
    setState({ kind: "unsaved" });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void save();
    }, STATEMENT_LIMITS.SAVE_DELAY_MS);
  };

  const savedName = (record?.reportFor?.name ?? "").trim();
  const blocked = owed.length > 0 && savedName === "";
  const month = owed[0] ?? monthOfDay(today);
  // The reference a new statement would start as; none while the stem is refused (it would read "Sept-Sept-321").
  const sample = stemProblem(typed.stem) === null ? referenceFromStem(typed.stem, month) : null;
  const cut = typed.name.trim() !== "" && reportForCut({ name: typed.name.trim(), address: typed.address });
  const invalid = state.kind === "invalid" ? state.problem : null;

  return (
    <tr className={styles.row} onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && flush()}>
      <td>
        <Link href={`/admin/property?id=${encodeURIComponent(propertyId)}`} prefetch={false} className={styles.propertyLink}>
          {name}
        </Link>
        {publicName && <span className={styles.sub}>{publicName}</span>}
        <span className={`${styles.state} ${state.kind === "failed" || state.kind === "invalid" ? styles.stateWarn : ""}`} aria-live="polite">
          {state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : state.kind === "unsaved" ? "Saving shortly" : state.kind === "failed" ? `Not saved: ${state.reason}` : state.kind === "invalid" ? `Not saved: ${state.problem}` : ""}
        </span>
      </td>
      <td>
        {status ? <ReportingStatusCell propertyId={propertyId} status={status} /> : <span className={styles.sub}>—</span>}
        {blocked && <span className={styles.blocked}>Blocked</span>}
      </td>
      <td>
        <input
          className={`${form.textInput} ${invalid && invalid.startsWith("Type a name") ? form.inputInvalid : ""}`}
          aria-label={`Report For name, ${name}`}
          value={typed.name}
          maxLength={STATEMENT_LIMITS.REPORT_FOR_NAME_MAX}
          // Words, not a sample: in a table of many rows a sample value reads as data.
          placeholder="Name"
          onChange={(e) => change({ name: e.target.value })}
        />
        {cut && <span className={form.noteWarn}>Cut short on the PDF</span>}
      </td>
      <td>
        <textarea
          className={`${form.textInput} ${styles.address}`}
          aria-label={`Report For address, ${name}`}
          value={typed.address}
          maxLength={STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX}
          rows={2}
          placeholder="Address"
          onChange={(e) => change({ address: e.target.value })}
        />
      </td>
      <td>
        <input
          className={`${form.textInput} ${invalid && invalid.startsWith("The stem") ? form.inputInvalid : ""}`}
          aria-label={`Reference stem, ${name}`}
          value={typed.stem}
          maxLength={STATEMENT_LIMITS.REFERENCE_STEM_MAX}
          placeholder="Stem"
          onChange={(e) => change({ stem: e.target.value })}
        />
        <span className={styles.sub} title={`A new statement for ${monthLabel(month)} starts with this reference`}>
          {sample ?? (typed.stem.trim() === "" ? "No stem" : "")}
        </span>
      </td>
      <td>
        <input
          className={`${form.textInput} ${form.amountInput} ${invalid && invalid.startsWith("The fee rate") ? form.inputInvalid : ""}`}
          aria-label={`Default fee rate in percent, ${name}`}
          inputMode="decimal"
          value={typed.rate}
          placeholder="Rate"
          onChange={(e) => change({ rate: e.target.value })}
        />
      </td>
    </tr>
  );
}
