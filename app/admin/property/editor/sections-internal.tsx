"use client";

/**
 * The Nubnb-only sections (dispatch 30): what the public never sees, kept
 * apart from the listing — whether the property is on the site and in
 * reporting (Status), the name cleaners see (Cleaners), the statements
 * record (Statements) and the calendar link (Calendar). The first three live
 * in their own server-only collections and are saved by their own routes;
 * the calendar link is on the document but stripped from every public read.
 */

import { Plus, X } from "lucide-react";
import { AdminSelect } from "../../components/AdminSelect";
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
    </Panel>
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
