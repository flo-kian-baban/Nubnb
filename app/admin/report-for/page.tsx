"use client";

/**
 * The Report For sheet (2026-10-17, build round 1 of the property page audit): one table of every property, with
 * its Report For name and address, its reference stem (Kian's ruling K5: a new statement's reference is suggested as
 * "<Mon>-<stem>") and its default fee rate (K6), each typed in place; and, since Kian's ruling of 2026-10-19, its two
 * cleaning prices — "Cleaning: short" for an ordinary turnover and "Cleaning: long (28+ nights)" after a long stay —
 * the base a cleaning's amount starts from.
 *
 * A row saves itself 800 ms after the last change, and at once when the cursor leaves it: the Report For fields
 * through the management route (PUT /api/admin/properties/[id]/management) with its three fields alone — every other
 * field of the record keeps what is stored, read and written in one transaction — and the two prices through their own
 * route (PUT /api/admin/properties/[id]/cleaning-prices) into their own server-only record. Each part is sent only
 * when it differs from what is stored. A row that cannot be saved says why in one line and sends nothing.
 *
 * "Import prices" (Kian's ruling of 2026-10-19): a CSV with the columns address, short and long. The page matches its
 * rows to properties by exact address, case and spaces ignored, shows the matched rows with their old → new values and
 * the unmatched rows by name, and saves only the matched rows, in one request, when the admin confirms in Nubnb's own
 * dialog. Nothing saves before the confirm.
 *
 * "Owes a statement" narrows the table to the properties with a statement owed now (the home's rule, `owedMonths`
 * over `reportingStatus`); a blocked one — owed, with no Report For name, the one thing Finish refuses — is marked.
 * Reached from the home's "Statements blocked" chip (?owes=1) and from the property page. The filter and the search
 * are kept in the address.
 *
 * Two reads: the statements tracker (GET /api/admin/monthly-reports), the home's, which holds every property's names,
 * created month and months with money, every management record and every finished statement; and every property's
 * cleaning prices (GET /api/admin/cleaning-prices).
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, RefreshCw, Search, Upload, X } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import { ReportingStatusCell } from "../components/StatementStatus";
import { Dialog } from "../property/editor/controls";
import { fetchTracker, type TrackerData } from "@/app/lib/reports-client";
import { setManagementFields } from "@/app/lib/firebase/properties";
import { fetchAllCleaningPrices, importCleaningPricesRows, setCleaningPricesOf } from "@/app/lib/prices-client";
import { LONG_STAY_NIGHTS, matchPriceRows, parsePricesCsv, priceField, type CleaningPrices, type MatchedPriceRow, type UnmatchedPriceRow } from "@/app/lib/cleanings/prices";
import { torontoDayOf } from "@/app/lib/costs/report";
import { monthLabel, monthOfDay, referenceFromStem, stemProblem, STATEMENT_LIMITS, type PropertyManagementView } from "@/app/lib/reports/model";
import { reportingStatuses, type ReportingStatus } from "@/app/lib/reports/statement";
import { reportForCut } from "@/app/lib/reports/statement-pdf";
import { owedMonths } from "@/app/lib/home/next-step";
import { pricesPayload, sameManagement, samePriceFields, sheetFieldsOf, sheetPayload, sheetProblem, type SheetFields } from "@/app/lib/reports/report-for-sheet";
import shared from "../page.module.css";
import form from "../property/page.module.css";
import ed from "../property/editor/editor.module.css";
import styles from "./page.module.css";

type Read<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; detail?: string; status: number };
/** The prices read: when it fails, the sheet still shows, with its two price columns locked. */
type PricesRead = { kind: "loading" } | { kind: "ready" } | { kind: "error"; title: string };

/** Accents and case set aside, as the home's search does. */
const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const money = (cents: number | null) => (cents === null ? "none" : `$${priceField(cents)}`);

export default function ReportForPage() {
  return (
    <PinGate>
      <Suspense fallback={null}>
        <Sheet />
      </Suspense>
    </PinGate>
  );
}

/** What the import dialog shows before anything is sent: the matched rows (those that change first) and the unmatched ones. */
interface ImportPreview {
  fileName: string;
  matched: MatchedPriceRow[];
  unmatched: UnmatchedPriceRow[];
}

function Sheet() {
  const params = useSearchParams();
  const [owesOnly, setOwesOnly] = useState(() => params.get("owes") === "1");
  const [query, setQuery] = useState(() => params.get("q") ?? "");
  const [tracker, setTracker] = useState<Read<TrackerData>>({ kind: "loading" });
  const [pricesRead, setPricesRead] = useState<PricesRead>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** Each property's record as the server last answered it: the tracker's, then each row's saves. */
  const [records, setRecords] = useState<Map<string, PropertyManagementView>>(new Map());
  /** Each property's cleaning prices as the server last answered them; absent when it has none. */
  const [prices, setPrices] = useState<Map<string, CleaningPrices>>(new Map());
  /** Bumped when the import saved: every row mounts afresh with the saved prices. */
  const [imported, setImported] = useState(0);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { notice, show, clear } = useNotice();
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
    fetchAllCleaningPrices().then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setPrices(new Map(Object.values(result.data.prices).map((record) => [record.propertyId, { shortTermCents: record.shortTermCents, longTermCents: record.longTermCents }])));
        setPricesRead({ kind: "ready" });
      } else {
        setPricesRead({ kind: "error", title: result.title });
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
  const priced = rows.filter((row) => prices.has(row.id) && (prices.get(row.id)!.shortTermCents !== null || prices.get(row.id)!.longTermCents !== null)).length;

  const onSaved = useCallback((record: PropertyManagementView) => {
    setRecords((prev) => new Map(prev).set(record.propertyId, record));
  }, []);
  const onPricesSaved = useCallback((propertyId: string, saved: CleaningPrices) => {
    setPrices((prev) => new Map(prev).set(propertyId, saved));
  }, []);

  // ── Import prices (Kian's ruling of 2026-10-19): read the file, match, show, save on confirm ──
  const readFile = async (file: File) => {
    clear();
    let text: string;
    try {
      text = await file.text();
    } catch {
      show({ tone: "error", title: `${file.name} could not be read.` });
      return;
    }
    const parsed = parsePricesCsv(text);
    if (parsed.kind === "bad") {
      show({ tone: "error", title: `${file.name} is not a prices file.`, detail: parsed.problem });
      return;
    }
    const { matched, unmatched } = matchPriceRows(
      parsed.rows,
      rows.map((row) => ({ id: row.id, name: row.name })),
      prices,
    );
    // Those that change first, then those the file leaves as they are, each A to Z.
    const sorted = [...matched].sort((a, b) => Number(b.changes) - Number(a.changes) || a.name.localeCompare(b.name, "en-CA"));
    setPreview({ fileName: file.name, matched: sorted, unmatched });
  };
  const confirmImport = async () => {
    if (!preview || importing) return;
    const changing = preview.matched.filter((row) => row.changes);
    if (changing.length === 0) {
      setPreview(null);
      show({ tone: "info", title: "Nothing to save: every matched row already holds what the file gives it." });
      return;
    }
    setImporting(true);
    const result = await importCleaningPricesRows(changing.map((row) => ({ propertyId: row.propertyId, shortTerm: row.after.shortTermCents === null ? null : priceField(row.after.shortTermCents), longTerm: row.after.longTermCents === null ? null : priceField(row.after.longTermCents) })));
    setImporting(false);
    if (!result.ok) {
      show(result.unknown ? { tone: "warning", title: "The prices may or may not have been saved. Refresh to see what is stored.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setPrices((prev) => {
      const next = new Map(prev);
      for (const saved of result.data.saved) next.set(saved.propertyId, { shortTermCents: saved.record.shortTermCents, longTermCents: saved.record.longTermCents });
      return next;
    });
    setImported((n) => n + 1);
    setPreview(null);
    const saved = result.data.saved.filter((s) => s.changed).length;
    const unchanged = preview.matched.length - changing.length;
    show({
      tone: "success",
      title: `Saved cleaning prices for ${saved === 1 ? "1 property" : `${saved} properties`} from ${preview.fileName}.`,
      detail: [unchanged > 0 ? `${unchanged} matched ${unchanged === 1 ? "row" : "rows"} already held what the file gives.` : null, preview.unmatched.length > 0 ? `${preview.unmatched.length} ${preview.unmatched.length === 1 ? "row was" : "rows were"} not saved: no matching property.` : null, "Cleanings already made keep their amounts."].filter(Boolean).join(" "),
    });
  };

  return (
    <div className={shared.container}>
      <AdminHeader current="properties" title="Report For" />
      <main className={shared.main}>
        <PageHead title="Report For">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className={styles.fileInput}
            aria-label="Prices file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void readFile(file);
            }}
          />
          <button type="button" className={shared.btnGhost} onClick={() => fileRef.current?.click()} disabled={tracker.kind !== "ready" || pricesRead.kind !== "ready"} title="A CSV with the columns address, short and long: rows are matched to properties by exact address, shown, and saved only when you confirm">
            <Upload size={15} aria-hidden />
            <span>Import prices</span>
          </button>
          <button type="button" className={shared.btnGhost} onClick={() => setAttempt((n) => n + 1)} disabled={tracker.kind === "loading"}>
            <RefreshCw size={15} aria-hidden />
            <span>Refresh</span>
          </button>
        </PageHead>

        {notice && <NoticeBanner className={shared.pageNotice} notice={notice} onDismiss={clear} />}
        {pricesRead.kind === "error" && <NoticeBanner className={shared.pageNotice} notice={{ tone: "warning", title: "The cleaning prices could not be read.", detail: `${pricesRead.title} The two price columns cannot be changed until the page is refreshed.` }} />}

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
        ) : tracker.kind === "loading" || !statuses || pricesRead.kind === "loading" ? (
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
                  <span className={styles.summary}>{pricesRead.kind === "ready" ? `${priced} of ${rows.length} with cleaning prices` : ""}</span>
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
                    <col className={styles.colPrice} />
                    <col className={styles.colPrice} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th aria-live="polite">{shown.length === rows.length ? `${rows.length} units` : `${shown.length} of ${rows.length} units`}</th>
                      <th>Statement</th>
                      <th>Report For name</th>
                      <th>Address</th>
                      <th title="The reference less its month: a new statement starts as <Mon>-<stem>">Reference stem</th>
                      <th title="What a new statement's fee starts from">Fee rate (%)</th>
                      <th title="What a cleaning after an ordinary turnover starts from, in dollars">Cleaning: short</th>
                      <th title={`What a cleaning after a stay of ${LONG_STAY_NIGHTS} nights or more starts from, in dollars`}>Cleaning: long ({LONG_STAY_NIGHTS}+ nights)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((row) => (
                      // Keyed by the read and the import too: Refresh, and a saved import, show each row as the server now holds it.
                      <SheetRow key={`${row.id}:${attempt}:${imported}`} propertyId={row.id} name={row.name} publicName={row.publicName} status={row.status} owed={row.owed} record={records.get(row.id) ?? null} prices={prices.get(row.id) ?? null} pricesLocked={pricesRead.kind !== "ready"} today={today} onSaved={onSaved} onPricesSaved={onPricesSaved} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {preview && <ImportDialog preview={preview} importing={importing} onConfirm={() => void confirmImport()} onClose={() => !importing && setPreview(null)} />}
      </main>
    </div>
  );
}

/**
 * What the import would save, before anything is sent (Kian's ruling of 2026-10-19): each matched row with its old →
 * new values, the rows the file leaves as they are, and the unmatched rows by name. The confirm saves the matched rows
 * that change, in one request; Escape, Cancel and the × save nothing.
 */
function ImportDialog({ preview, importing, onConfirm, onClose }: { preview: ImportPreview; importing: boolean; onConfirm: () => void; onClose: () => void }) {
  const changing = preview.matched.filter((row) => row.changes);
  const same = preview.matched.length - changing.length;
  const WHY: Record<UnmatchedPriceRow["why"], string> = {
    "no property with this address": "no property has this address",
    "two or more properties share this address": "two or more properties have this address",
    "another row names the same property": "another row names the same property",
    "a price is not readable": "a price is not dollars and cents",
  };
  return (
    <Dialog
      title={`Import cleaning prices from ${preview.fileName}?`}
      wide
      onClose={onClose}
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={importing}>
            Cancel
          </button>
          <button type="button" className={`${ed.btn} ${ed.btnPrimary}`} onClick={onConfirm} disabled={importing || changing.length === 0}>
            {importing ? "Saving…" : changing.length === 0 ? "Nothing to save" : `Save ${changing.length === 1 ? "1 row" : `${changing.length} rows`}`}
          </button>
        </>
      }
    >
      <div className={styles.importBody}>
        <p>
          {preview.matched.length === 0 ? "No row matches a property." : `${preview.matched.length === 1 ? "1 row matches" : `${preview.matched.length} rows match`} a property by its address${same > 0 ? `, ${same} already as in the file` : ""}.`}
          {preview.unmatched.length > 0 && ` ${preview.unmatched.length === 1 ? "1 row is" : `${preview.unmatched.length} rows are`} not saved.`} Nothing is saved until you confirm. Cleanings already made keep their amounts.
        </p>
        {preview.matched.length > 0 && (
          <table className={styles.importTable} aria-label="Matched rows">
            <thead>
              <tr>
                <th>Property</th>
                <th>Short</th>
                <th>Long ({LONG_STAY_NIGHTS}+ nights)</th>
              </tr>
            </thead>
            <tbody>
              {preview.matched.map((row) => (
                <tr key={row.propertyId} className={row.changes ? undefined : styles.importSame}>
                  <td>{row.name}</td>
                  <td>
                    <Change before={row.before.shortTermCents} after={row.after.shortTermCents} />
                  </td>
                  <td>
                    <Change before={row.before.longTermCents} after={row.after.longTermCents} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {preview.unmatched.length > 0 && (
          <div className={styles.unmatched}>
            <p>
              <b>Not saved</b> — {preview.unmatched.length === 1 ? "this row matches" : "these rows match"} no property as typed:
            </p>
            <ul>
              {preview.unmatched.map((item) => (
                <li key={item.row.line}>
                  <span>{item.row.address}</span>
                  <span className={styles.why}>
                    line {item.row.line} · {WHY[item.why]}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

/** "$80.00 → $100.00", or the one value when it does not change. */
function Change({ before, after }: { before: number | null; after: number | null }) {
  if (before === after) return <span className={styles.unchanged}>{money(after)}</span>;
  return (
    <span>
      <span className={styles.before}>{money(before)}</span> → <b>{money(after)}</b>
    </span>
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
  /** The cleaning prices as the server last answered them; null when the property has none. */
  prices: CleaningPrices | null;
  /** The prices could not be read: the two price fields cannot be changed. */
  pricesLocked: boolean;
  today: string;
  onSaved: (record: PropertyManagementView) => void;
  onPricesSaved: (propertyId: string, prices: CleaningPrices) => void;
}

/** One property: its six fields, typed in place, saved 800 ms after the last change and when the cursor leaves the row; each route sent only what differs. */
function SheetRow({ propertyId, name, publicName, status, owed, record, prices, pricesLocked, today, onSaved, onPricesSaved }: RowProps) {
  const [typed, setTyped] = useState<SheetFields>(() => sheetFieldsOf(record, prices));
  const [state, setState] = useState<RowState>({ kind: "idle" });
  const typedRef = useRef(typed);
  typedRef.current = typed;
  /** What the server holds for the row's fields. */
  const storedRef = useRef<SheetFields>(sheetFieldsOf(record, prices));
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
        const managementDiffers = !sameManagement(current, storedRef.current);
        const pricesDiffer = !pricesLocked && !samePriceFields(current, storedRef.current);
        if (!managementDiffers && !pricesDiffer) {
          setState((was) => (was.kind === "unsaved" || was.kind === "invalid" || was.kind === "saving" ? { kind: "saved" } : was));
          continue;
        }
        const problem = sheetProblem(current);
        if (problem) {
          setState({ kind: "invalid", problem });
          continue;
        }
        setState({ kind: "saving" });
        let failed: string | null = null;
        if (managementDiffers) {
          const result = await setManagementFields(propertyId, sheetPayload(current));
          if (result.ok) {
            const stored = sheetFieldsOf(result.data.record, null);
            storedRef.current = { ...storedRef.current, name: stored.name, address: stored.address, stem: stored.stem, rate: stored.rate };
            onSaved(result.data.record);
          } else {
            const issue = result.issues[0]?.message;
            failed = issue ? `${result.error}: ${issue}` : result.status === 401 || result.status === 403 ? `${result.error}. Your admin session may have expired — reload and sign in again.` : result.error;
          }
        }
        if (pricesDiffer && failed === null) {
          const result = await setCleaningPricesOf(propertyId, pricesPayload(current));
          if (result.ok) {
            const saved: CleaningPrices = { shortTermCents: result.data.record.shortTermCents, longTermCents: result.data.record.longTermCents };
            storedRef.current = { ...storedRef.current, short: priceField(saved.shortTermCents), long: priceField(saved.longTermCents) };
            onPricesSaved(propertyId, saved);
          } else {
            failed = result.unknown ? `${result.title} The prices may or may not have been saved: refresh to see.` : result.title;
          }
        }
        if (failed !== null) setState({ kind: "failed", reason: failed });
        else setState(sameManagement(typedRef.current, storedRef.current) && (pricesLocked || samePriceFields(typedRef.current, storedRef.current)) ? { kind: "saved" } : { kind: "unsaved" });
      } while (again.current);
    } finally {
      sending.current = false;
    }
  }, [propertyId, pricesLocked, onSaved, onPricesSaved]);

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
      <td>
        <input
          className={`${form.textInput} ${form.amountInput} ${invalid && invalid.startsWith("The short-term") ? form.inputInvalid : ""}`}
          aria-label={`Short-term cleaning price, ${name}`}
          inputMode="decimal"
          value={typed.short}
          placeholder="Price"
          disabled={pricesLocked}
          onChange={(e) => change({ short: e.target.value })}
        />
      </td>
      <td>
        <input
          className={`${form.textInput} ${form.amountInput} ${invalid && invalid.startsWith("The long-term") ? form.inputInvalid : ""}`}
          aria-label={`Long-term cleaning price, ${name}`}
          inputMode="decimal"
          value={typed.long}
          placeholder="Price"
          disabled={pricesLocked}
          onChange={(e) => change({ long: e.target.value })}
        />
      </td>
    </tr>
  );
}
