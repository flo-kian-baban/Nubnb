"use client";

/**
 * The Nubnb-only sections (dispatch 30): what the public never sees, kept
 * apart from the listing — whether the property is on the site and in
 * reporting (Status), the name cleaners see and the regular cleaner
 * (Cleaners), the statements record (Statements) and the calendar link
 * (Calendar). The first three live in their own server-only collections and
 * are saved by their own routes; the calendar link is on the document but
 * stripped from every public read. The regular cleaner (Kian's ruling R5 of
 * 2026-10-19) and the cleaning prices (Kian's ruling of 2026-10-19) save on
 * their own, not with the property's Save: the prices 800 ms after the last
 * change and when the cursor leaves them, as the Report For sheet saves.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { AdminSelect } from "../../components/AdminSelect";
import { useAsk } from "../../components/AskDialog";
import { fetchRegularCleaner, setRegularCleanerOf, type RegularCleanerAnswer } from "@/app/lib/schedule-client";
import { regularCleanerQuestion } from "@/app/lib/schedule/regular";
import { fetchCleaningPrices, setCleaningPricesOf } from "@/app/lib/prices-client";
import { LONG_STAY_NIGHTS, priceField, priceTextForRoute, readPriceText, type CleaningPrices } from "@/app/lib/cleanings/prices";
import { STATEMENT_LIMITS, monthLabel, monthOfDay, referenceFromStem } from "@/app/lib/reports/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import { Field, Switch, TextArea, TextInput } from "./controls";
import { monthChoices, type ManagementDraft } from "./model";
import { Panel, Tile, fieldIssue, isInvalid, type SectionContext } from "./shared";
import styles from "./editor.module.css";

const UNREADABLE = "It could not be read just now, so it cannot be changed until the page is reloaded.";

export function StatusSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setDraft, managementState } = ctx;
  const managementLocked = managementState === "loading" || managementState === "unavailable";
  return (
    <Panel title="Status" state={ctx.state} internal>
      <Tile title="On the site" span={6}>
        <Switch
          bare
          label="Unlisted"
          field="unlisted"
          checked={draft.unlisted}
          onChange={(checked) => setDraft((prev) => ({ ...prev, unlisted: checked }))}
          description="Not on the public site: the homepage, the map, its own page, the property API. Still in the admin, the cleaner app, availability and reporting."
        />
      </Tile>
      <Tile title="In reporting" span={6}>
        <Switch
          bare
          label="Exclude from reporting"
          field="management.excluded"
          checked={draft.management.excluded}
          disabled={managementLocked}
          onChange={(checked) => setDraft((prev) => ({ ...prev, management: { ...prev.management, excluded: checked } }))}
          description={managementState === "unavailable" ? `The statements record could not be read. ${UNREADABLE}` : "Owes no statements: left out of the Statement column, the tile and the home panel. Costs and income stay."}
        />
      </Tile>
    </Panel>
  );
}

export function CleanersSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setDraft, cleanerNameState } = ctx;
  const locked = cleanerNameState === "loading" || cleanerNameState === "unavailable";
  const title = draft.property.name?.trim() || "the title";
  return (
    <Panel title="Cleaners" state={ctx.state} internal>
      <Tile title="Name for cleaners" span={8}>
        <TextInput
          field="cleanerName"
          value={draft.cleanerName}
          onChange={(value) => setDraft((prev) => ({ ...prev, cleanerName: value }))}
          maxLength={120}
          placeholder={cleanerNameState === "loading" ? "Loading…" : "e.g. 321 John St, unit 4"}
          disabled={locked}
          invalid={isInvalid(ctx, "cleanerName")}
          aria-label="Name for cleaners"
        />
        {(fieldIssue(ctx, "cleanerName") || cleanerNameState === "unavailable") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "cleanerName") ?? `The name could not be read. ${UNREADABLE}`}
          </span>
        )}
        <span className={styles.hint}>Shown instead of the title in the cleaners&rsquo; app, on every admin list, and on statements and cost exports. Empty uses &ldquo;{title}&rdquo;.</span>
      </Tile>
      <RegularCleanerTile ctx={ctx} />
      <CleaningPricesTile ctx={ctx} />
    </Panel>
  );
}

type PricesRead = { kind: "loading" } | { kind: "ready"; prices: CleaningPrices; unreadable: boolean } | { kind: "error"; title: string };
type PricesState = { kind: "idle" } | { kind: "unsaved" } | { kind: "saving" } | { kind: "saved" } | { kind: "invalid"; problem: string } | { kind: "failed"; reason: string };

/** A typed price as the field compares it: "80.00", '' for none, or the text itself when it is not a price. */
const priceKey = (text: string) => {
  const read = readPriceText(text);
  return read.kind === "none" ? "" : read.kind === "cents" ? priceField(read.cents) : `?${text}`;
};

/**
 * Cleaning prices (Kian's ruling of 2026-10-19): the property's short-term preset, for an ordinary turnover, and its
 * long-term preset, after a stay of 28 nights or more. A Mark cleaned takes the one the stay calls for; the admin can
 * change any cleaning's amount. Saved on their own through their own route into a server-only record, 800 ms after the
 * last change and when the cursor leaves the tile, as the Report For sheet saves; a change never touches an existing
 * cleaning.
 */
function CleaningPricesTile({ ctx }: { ctx: SectionContext }) {
  const id = ctx.propertyId;
  const [read, setRead] = useState<PricesRead>({ kind: "loading" });
  const [typed, setTyped] = useState({ short: "", long: "" });
  const [state, setState] = useState<PricesState>({ kind: "idle" });
  const typedRef = useRef(typed);
  typedRef.current = typed;
  const storedRef = useRef({ short: "", long: "" });
  const timer = useRef<number | null>(null);
  const sending = useRef(false);
  const again = useRef(false);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchCleaningPrices(id).then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setRead({ kind: "error", title: result.title });
        return;
      }
      const prices: CleaningPrices = { shortTermCents: result.data.record?.shortTermCents ?? null, longTermCents: result.data.record?.longTermCents ?? null };
      const fields = { short: priceField(prices.shortTermCents), long: priceField(prices.longTermCents) };
      storedRef.current = fields;
      setTyped(fields);
      setRead({ kind: "ready", prices, unreadable: result.data.unreadable });
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  const same = (a: { short: string; long: string }, b: { short: string; long: string }) => priceKey(a.short) === priceKey(b.short) && priceKey(a.long) === priceKey(b.long);
  const problemOf = (fields: { short: string; long: string }) => (readPriceText(fields.short).kind === "bad" ? "The short-term price is dollars and cents, like 80 or 80.00." : readPriceText(fields.long).kind === "bad" ? "The long-term price is dollars and cents, like 120 or 120.00." : null);

  /** Send what is typed until what is stored matches it: one save at a time; a change made while one is out is sent after it. */
  const save = useCallback(async () => {
    if (!id || sending.current) {
      again.current = true;
      return;
    }
    sending.current = true;
    try {
      do {
        again.current = false;
        const current = typedRef.current;
        if (same(current, storedRef.current)) {
          setState((was) => (was.kind === "unsaved" || was.kind === "invalid" || was.kind === "saving" ? { kind: "saved" } : was));
          continue;
        }
        const problem = problemOf(current);
        if (problem) {
          setState({ kind: "invalid", problem });
          continue;
        }
        setState({ kind: "saving" });
        const result = await setCleaningPricesOf(id, { shortTerm: priceTextForRoute(current.short) ?? null, longTerm: priceTextForRoute(current.long) ?? null });
        if (result.ok) {
          storedRef.current = { short: priceField(result.data.record.shortTermCents), long: priceField(result.data.record.longTermCents) };
          setState(same(typedRef.current, storedRef.current) ? { kind: "saved" } : { kind: "unsaved" });
        } else {
          setState({ kind: "failed", reason: result.unknown ? `${result.title} It may or may not have been saved: reload to see.` : result.title });
        }
      } while (again.current);
    } finally {
      sending.current = false;
    }
  }, [id]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
      void save();
    }
  }, [save]);
  useEffect(() => () => flush(), [flush]);

  const change = (patch: Partial<{ short: string; long: string }>) => {
    setTyped((was) => ({ ...was, ...patch }));
    setState({ kind: "unsaved" });
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void save();
    }, STATEMENT_LIMITS.SAVE_DELAY_MS);
  };

  if (!id) {
    return (
      <Tile title="Cleaning prices" span={12}>
        <span className={styles.hint}>Its cleaning prices are set once the property exists: create it first.</span>
      </Tile>
    );
  }
  const locked = read.kind !== "ready";
  const words = state.kind === "saving" ? "Saving…" : state.kind === "saved" ? "Saved" : state.kind === "unsaved" ? "Saving shortly" : state.kind === "failed" ? `Not saved: ${state.reason}` : state.kind === "invalid" ? `Not saved: ${state.problem}` : "";
  return (
    <Tile title="Cleaning prices" span={12} aside={words || undefined}>
      <div className={`${styles.fields} ${styles.cols2}`} onBlur={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && flush()}>
        <Field label="Short-term (an ordinary turnover), $">
          <TextInput field="cleaningPrices.short" inputMode="decimal" value={typed.short} onChange={(value) => change({ short: value })} placeholder={read.kind === "loading" ? "Loading…" : "e.g. 80.00"} disabled={locked} invalid={state.kind === "invalid" && state.problem.startsWith("The short")} aria-label="Short-term cleaning price" />
        </Field>
        <Field label={`Long-term (after ${LONG_STAY_NIGHTS}+ nights), $`}>
          <TextInput field="cleaningPrices.long" inputMode="decimal" value={typed.long} onChange={(value) => change({ long: value })} placeholder={read.kind === "loading" ? "Loading…" : "e.g. 120.00"} disabled={locked} invalid={state.kind === "invalid" && state.problem.startsWith("The long")} aria-label="Long-term cleaning price" />
        </Field>
      </div>
      {read.kind === "error" ? (
        <span className={styles.issue} role="alert">
          {read.title} They cannot be changed until the page is reloaded.
        </span>
      ) : read.kind === "ready" && read.unreadable ? (
        <span className={styles.issue} role="alert">
          The stored prices could not be read. Typing new ones replaces them.
        </span>
      ) : state.kind === "failed" || state.kind === "invalid" ? (
        <span className={styles.issue} role="alert" aria-live="polite">
          {words}
        </span>
      ) : (
        <span className={styles.hint}>What a cleaning here starts from: a Mark cleaned takes the price the stay calls for; with several cleaners on a job, or no price, it waits for an amount. Any cleaning&rsquo;s amount can be changed. Saved on their own, shortly after typing; cleanings already made keep their amounts.</span>
      )}
    </Tile>
  );
}

type RegularRead = { kind: "loading" } | { kind: "ready"; data: RegularCleanerAnswer } | { kind: "error"; title: string };

/**
 * The regular cleaner (Kian's ruling R5 of 2026-10-19): one active cleaner, or none. When the job sync makes a job for
 * this property, it puts them on it; a deactivated or deleted one assigns nobody. Saved at once through its own route
 * into a server-only record, after Nubnb's own question; jobs already made are not changed.
 */
function RegularCleanerTile({ ctx }: { ctx: SectionContext }) {
  const id = ctx.propertyId;
  const [read, setRead] = useState<RegularRead>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const { ask, dialog } = useAsk();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchRegularCleaner(id, true).then((result) => {
      if (!cancelled) setRead(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  if (!id) {
    return (
      <Tile title="Regular cleaner" span={4}>
        <span className={styles.hint}>Its regular cleaner is set once the property exists: create it first.</span>
      </Tile>
    );
  }
  const data = read.kind === "ready" ? read.data : null;
  const current = data?.regular ?? null;
  const choices = data?.choices ?? [];
  const options = [{ value: "", label: "No regular cleaner" }, ...choices.map((c) => ({ value: c.id, label: c.name ?? "Unnamed" })), ...(current && !choices.some((c) => c.id === current.cleanerId) ? [{ value: current.cleanerId, label: `${current.name ?? "Unnamed"} (${current.state === "missing" ? "deleted" : "deactivated"})` }] : [])];
  const property = ctx.draft.cleanerName.trim() || ctx.draft.property.name?.trim() || "this property";

  const choose = async (cleanerId: string) => {
    if (!data || saving || cleanerId === (current?.cleanerId ?? "")) return;
    const picked = choices.find((c) => c.id === cleanerId) ?? null;
    const yes = await ask(
      picked
        ? regularCleanerQuestion(picked.name, property)
        : { title: `No regular cleaner for ${property}?`, lines: ["Each job made for it from now on starts with nobody on it.", "Jobs already made are not changed.", "Saved on its own, now: not with the property's Save."], confirm: "Clear it" },
    );
    if (!yes) return;
    setSaving(true);
    const result = await setRegularCleanerOf(id, cleanerId === "" ? null : cleanerId);
    setSaving(false);
    if (!result.ok) {
      ctx.show({ tone: result.unknown ? "warning" : "error", title: result.unknown ? "The regular cleaner may or may not have been saved. Reload to see." : result.title, detail: result.detail });
      return;
    }
    ctx.show({ tone: "success", title: picked ? `${picked.name ?? "They"} ${picked.name ? "is" : "are"} the regular cleaner for ${property}.` : `${property} has no regular cleaner.` });
    setAttempt((n) => n + 1);
  };

  return (
    <Tile title="Regular cleaner" span={4}>
      <AdminSelect label="Regular cleaner" value={current?.cleanerId ?? ""} onChange={(value) => void choose(value)} groups={[{ options }]} disabled={read.kind !== "ready" || saving} />
      {read.kind === "error" ? (
        <span className={styles.issue} role="alert">
          {read.title} It cannot be changed until the page is reloaded.
        </span>
      ) : current && !current.assigns ? (
        <span className={styles.issue} role="alert">
          {current.name ?? "They"} {current.state === "missing" ? "no longer exists" : "is deactivated"}: new jobs here are made with nobody on them. Choose another, or none.
        </span>
      ) : data?.unreadable ? (
        <span className={styles.issue} role="alert">
          Its record could not be read. Choosing again replaces it.
        </span>
      ) : (
        <span className={styles.hint}>New jobs here go to them when they are made. Jobs already made are not changed. Saved on its own, at once.</span>
      )}
      {dialog}
    </Tile>
  );
}

export function StatementsSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setDraft, managementState } = ctx;
  const m = draft.management;
  const locked = managementState === "loading" || managementState === "unavailable";
  const set = (patch: Partial<ManagementDraft>) => setDraft((prev) => ({ ...prev, management: { ...prev.management, ...patch } }));
  const months = monthChoices(new Date(), [m.from, m.until]);
  const monthOptions = months.map((month) => ({ value: month, label: monthLabel(month) }));
  const byYear = [...new Set(months.map((month) => month.slice(0, 4)))].map((year) => ({ label: year, options: monthOptions.filter((o) => o.value.startsWith(year)) }));
  /** The reference a statement for this month would start from, from the stem as typed. */
  const stemSample = referenceFromStem(m.referenceStem, monthOfDay(torontoDayOf(new Date())));

  return (
    <Panel title="Statements" state={ctx.state} internal note={managementState === "unavailable" ? `The statements record could not be read. ${UNREADABLE}` : "Who the Payment Summary is for, the months statements run, and the fee rate and reference a statement starts from. Nothing here sends email."}>
      <Tile title="Report For" span={6}>
        <div className={styles.fields}>
          <Field label="Name" issue={fieldIssue(ctx, "management.reportForName")}>
            <TextInput field="management.reportForName" value={m.reportForName} onChange={(value) => set({ reportForName: value })} maxLength={STATEMENT_LIMITS.REPORT_FOR_NAME_MAX} placeholder="Name" disabled={locked} invalid={isInvalid(ctx, "management.reportForName")} aria-label="Report For name" />
          </Field>
          <Field label="Address" issue={fieldIssue(ctx, "management.reportForAddress")}>
            <TextArea field="management.reportForAddress" value={m.reportForAddress} onChange={(value) => set({ reportForAddress: value })} maxLength={STATEMENT_LIMITS.REPORT_FOR_ADDRESS_MAX} rows={3} placeholder={"123-45 Example St.\nToronto, ON, A1B 2C3"} disabled={locked} className={styles.textarea} aria-label="Report For address" style={{ minHeight: 72 }} />
          </Field>
        </div>
      </Tile>

      <Tile title="Owners" span={6} aside={m.owners.length > 0 ? `${m.owners.length} of ${STATEMENT_LIMITS.OWNERS_MAX}` : undefined}>
        <span className={styles.hint}>Names and emails, kept for a later sending decision. Nothing sends.</span>
        <div className={styles.list}>
          {m.owners.map((owner, i) => (
            <div key={i} className={styles.ownerRow}>
              <TextInput field={`management.owners.${i}.name`} value={owner.name} onChange={(value) => set({ owners: m.owners.map((o, j) => (j === i ? { ...o, name: value } : o)) })} maxLength={STATEMENT_LIMITS.OWNER_NAME_MAX} placeholder="Owner's name" disabled={locked} invalid={isInvalid(ctx, `management.owners.${i}.name`)} aria-label={`Owner ${i + 1} name`} />
              <TextInput field={`management.owners.${i}.email`} value={owner.email} onChange={(value) => set({ owners: m.owners.map((o, j) => (j === i ? { ...o, email: value } : o)) })} maxLength={STATEMENT_LIMITS.OWNER_EMAIL_MAX} placeholder="Email (optional, not used yet)" disabled={locked} aria-label={`Owner ${i + 1} email`} />
              <button type="button" className={`${styles.rowBtn} ${styles.rowBtnDanger}`} aria-label={`Remove owner ${i + 1}`} title="Remove" disabled={locked} onClick={() => set({ owners: m.owners.filter((_, j) => j !== i) })}>
                <X size={14} aria-hidden />
              </button>
            </div>
          ))}
          {fieldIssue(ctx, "management.owners") && (
            <span className={styles.issue} role="alert" data-issue>
              {fieldIssue(ctx, "management.owners")}
            </span>
          )}
          {m.owners.length < STATEMENT_LIMITS.OWNERS_MAX && (
            <button type="button" className={`${styles.btn} ${styles.btnGhost} ${styles.btnSmall}`} style={{ alignSelf: "flex-start" }} disabled={locked} onClick={() => set({ owners: [...m.owners, { name: "", email: "" }] })}>
              <Plus size={14} aria-hidden /> Add an owner
            </button>
          )}
        </div>
      </Tile>

      <Tile title="Statements run" span={6}>
        <div className={`${styles.fields} ${styles.cols2}`}>
          <Field label="From" field="management.from" issue={fieldIssue(ctx, "management.from")}>
            <AdminSelect label="Statements from" className={styles.selectFull} value={m.from} onChange={(value) => set({ from: value })} groups={byYear} disabled={locked} invalid={isInvalid(ctx, "management.from")} placeholder="Pick a month" />
          </Field>
          <Field label="Until" field="management.until" issue={fieldIssue(ctx, "management.until")}>
            <AdminSelect label="Until" className={styles.selectFull} value={m.until} onChange={(value) => set({ until: value })} groups={[{ options: [{ value: "", label: "No end" }] }, ...byYear]} disabled={locked} invalid={isInvalid(ctx, "management.until")} />
          </Field>
        </div>
      </Tile>

      <Tile title="Default fee rate (%)" span={3}>
        <TextInput field="management.feeRate" inputMode="decimal" value={m.feeRate} onChange={(value) => set({ feeRate: value })} placeholder="20" disabled={locked} invalid={isInvalid(ctx, "management.feeRate")} aria-label="Default fee rate in percent" />
        {fieldIssue(ctx, "management.feeRate") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "management.feeRate")}
          </span>
        )}
        <span className={styles.hint}>What a new statement starts from, like 20 or 12.5.</span>
      </Tile>

      {/* Kian's ruling K5 of 2026-10-17: a new statement's reference is suggested as "<Mon>-<stem>". */}
      <Tile title="Reference stem" span={3}>
        <TextInput field="management.referenceStem" value={m.referenceStem} onChange={(value) => set({ referenceStem: value })} maxLength={STATEMENT_LIMITS.REFERENCE_STEM_MAX} placeholder="321-John" disabled={locked} invalid={isInvalid(ctx, "management.referenceStem")} aria-label="Reference stem" />
        {fieldIssue(ctx, "management.referenceStem") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "management.referenceStem")}
          </span>
        )}
        <span className={styles.hint}>{stemSample ? `A new statement starts as ${stemSample}.` : "The reference less its month: 321-John gives Sept-321-John."}</span>
      </Tile>
    </Panel>
  );
}

export function CalendarSection({ ctx }: { ctx: SectionContext }) {
  const { draft, setProperty } = ctx;
  return (
    <Panel title="Calendar" state={ctx.state} internal>
      <Tile title="Calendar link (iCal)" span={8}>
        <TextInput field="icalUrl" value={draft.property.icalUrl ?? ""} onChange={(value) => setProperty((prev) => ({ ...prev, icalUrl: value }))} placeholder="https://www.airbnb.ca/calendar/ical/….ics?s=…" invalid={isInvalid(ctx, "icalUrl")} aria-label="Calendar link" />
        {fieldIssue(ctx, "icalUrl") && (
          <span className={styles.issue} role="alert" data-issue>
            {fieldIssue(ctx, "icalUrl")}
          </span>
        )}
        <span className={styles.hint}>Airbnb&apos;s calendar export, read for availability. It carries a secret key and is never sent to a visitor.</span>
      </Tile>
    </Panel>
  );
}
