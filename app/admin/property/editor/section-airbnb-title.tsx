"use client";

/**
 * Airbnb title (dispatch 37C, Kian's rulings of 2026-10-13): each property holds one active Airbnb title, set here;
 * previous titles are kept so older files still match. A row of an Airbnb file belongs to this property through its
 * active title or any previous one.
 *
 * The property save never writes it: this section saves on its own, through its own route
 * (/api/admin/properties/[id]/airbnb-title), into a server-only record, never onto the world-readable property
 * document. The Income page's Link is a second way to set the same title (M12).
 *
 * "Change title" picks a title from the uploaded files that belongs to no other property, or takes one typed exactly
 * as Airbnb writes it. The title it replaces becomes a previous one. A title another property holds moves here only
 * while none of its lines is on a finished statement, its unfinished accepted lines going back for review (M13); the
 * question says so first, in Nubnb's own dialog. Nothing is applied without the admin.
 */

import { useEffect, useMemo, useState } from "react";
import { AdminSelect } from "../../components/AdminSelect";
import { useAsk } from "../../components/AskDialog";
import { fetchPropertyTitles, setPropertyTitle, type PropertyTitles } from "@/app/lib/income-client";
import { NOT_NUBNB, isActiveTitle, normaliseTitle } from "@/app/lib/income/model";
import { dateText, monthLabel } from "@/app/lib/reports/model";
import { TextInput } from "./controls";
import { Panel, Tile, type SectionContext } from "./shared";
import styles from "./editor.module.css";

type Read = { kind: "loading" } | { kind: "ready"; data: PropertyTitles } | { kind: "error"; title: string; detail?: string };

/** The day a link was made, as the admin reads it: "Oct 13, 2026". */
const linkedDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? dateText(iso.slice(0, 10)) : iso);

export function AirbnbTitleSection({ ctx }: { ctx: SectionContext }) {
  const id = ctx.propertyId;
  const [read, setRead] = useState<Read>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [changing, setChanging] = useState(false);
  const [picked, setPicked] = useState("");
  const [typed, setTyped] = useState("");
  const [saving, setSaving] = useState(false);
  /** Questions in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchPropertyTitles(id).then((result) => {
      if (cancelled) return;
      setRead(result.ok ? { kind: "ready", data: result.data } : { kind: "error", title: result.title, detail: result.detail });
    });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const data = read.kind === "ready" ? read.data : null;
  const active = data?.titles.find((row) => isActiveTitle(row.link)) ?? null;
  const previous = data?.titles.filter((row) => !isActiveTitle(row.link)) ?? [];
  const options = useMemo(
    () => [{ options: [{ value: "", label: "Pick a title from the files" }, ...(data?.candidates ?? []).filter((c) => c.title !== active?.link.title).map((c) => ({ value: c.title, label: `${c.title} · ${c.months.length > 0 ? c.months.map(monthLabel).join(", ") : "in no file"}${c.setAside ? " · set aside" : ""}` }))] }],
    [data, active],
  );

  if (!id) {
    return (
      <Panel title="Airbnb title" state={ctx.state} internal>
        <Tile span={12}>
          <span className={styles.hint}>Its Airbnb title is set once the property exists: create it first.</span>
        </Tile>
      </Panel>
    );
  }

  const save = async () => {
    if (!data || saving) return;
    const title = normaliseTitle(typed) || picked;
    if (title === "") {
      ctx.show({ tone: "error", title: "Pick a title, or type it exactly as Airbnb writes it." });
      return;
    }
    if (title === active?.link.title) {
      setChanging(false);
      return;
    }
    // The title's link as the page sees it: this property's (a previous title), another's, set aside, or none.
    const mine = data.titles.find((row) => row.link.title === title) ?? null;
    const other = data.elsewhere.find((row) => row.title === title) ?? null;
    const expected = mine ? id : (other?.state ?? null);
    const moves = other && other.state !== null && other.state !== NOT_NUBNB;
    const yes = await ask({
      title: `Make “${title}” this property's Airbnb title?`,
      lines: [
        active ? `“${active.link.title}” becomes a previous title, still this property's, so older files still match.` : null,
        moves ? `“${title}” is ${other?.propertyName ?? "another property"}'s title now. It moves here only while none of its lines is on a finished statement; its lines accepted there and not yet printed go back for review.` : null,
        "Saved on its own, now: not with the property's Save.",
      ],
      confirm: "Make it its title",
    });
    if (!yes) return;
    setSaving(true);
    const result = await setPropertyTitle(id, { title, expected });
    setSaving(false);
    if (!result.ok) {
      ctx.show({ tone: result.status === 409 ? "warning" : "error", title: result.title, detail: [result.detail, result.evidence && typeof result.evidence.statements === "string" ? `On: ${result.evidence.statements}.` : null].filter(Boolean).join(" ") || undefined });
      return;
    }
    setChanging(false);
    setPicked("");
    setTyped("");
    ctx.show({
      tone: "success",
      title: `“${result.data.link.title}” is this property's Airbnb title.`,
      detail: [result.data.previous ? `“${result.data.previous}” is now a previous title.` : null, result.data.sentBack > 0 ? `${result.data.sentBack === 1 ? "1 line went" : `${result.data.sentBack} lines went`} back for review on the Income page.` : null].filter(Boolean).join(" ") || undefined,
    });
    setAttempt((n) => n + 1);
  };

  return (
    <Panel title="Airbnb title" state={ctx.state} internal>
      <Tile
        title="Active title"
        span={12}
        aside={
          data && !changing ? (
            <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => setChanging(true)}>
              Change title
            </button>
          ) : null
        }
      >
        {read.kind === "loading" ? (
          <span className={styles.hint}>Loading…</span>
        ) : read.kind === "error" ? (
          <span className={styles.issue} role="alert">
            {read.title}
            {read.detail ? ` ${read.detail}` : ""} It cannot be changed until the page is reloaded.
          </span>
        ) : active ? (
          <>
            <span className={styles.titleWords}>“{active.link.title}”</span>
            <span className={styles.hint}>
              Linked {linkedDay(active.link.linkedAt)} · {active.lastSeen ? `last in ${monthLabel(active.lastSeen)}'s file` : "in no file yet"}
            </span>
          </>
        ) : (
          <span className={styles.hint}>No Airbnb title yet: its rows in Airbnb&apos;s files are not matched to it.</span>
        )}
      </Tile>

      {changing && data && (
        <Tile title="Change title" span={12}>
          <div className={styles.titleChange}>
            <AdminSelect label="Pick a title from the files" className={styles.selectFull} value={picked} onChange={(value) => { setPicked(value); if (value) setTyped(""); }} groups={options} searchable disabled={saving} />
            <TextInput field="airbnbTitle" value={typed} onChange={(value) => { setTyped(value); if (value) setPicked(""); }} placeholder="Or type it exactly, as Airbnb writes it" aria-label="The title, typed exactly" disabled={saving} />
            <div className={styles.titleActions}>
              <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => void save()} disabled={saving || (picked === "" && normaliseTitle(typed) === "")}>
                {saving ? "Saving…" : "Save title"}
              </button>
              <button type="button" className={`${styles.btn} ${styles.btnGhost}`} onClick={() => { setChanging(false); setPicked(""); setTyped(""); }} disabled={saving}>
                Cancel
              </button>
            </div>
          </div>
          <span className={styles.hint}>The list holds the titles in uploaded files that belong to no other property. Saved on its own, not with the property&apos;s Save.</span>
        </Tile>
      )}

      {data && (
        <Tile title="Previous titles" span={12}>
          {previous.length === 0 ? (
            <span className={styles.hint}>None.</span>
          ) : (
            <ul className={styles.titleList}>
              {previous.map(({ link, lastSeen }) => (
                <li key={link.id}>
                  <span className={styles.titleWords}>“{link.title}”</span>
                  <span className={styles.hint}>{lastSeen ? `last in ${monthLabel(lastSeen)}'s file` : "in no file"}</span>
                </li>
              ))}
            </ul>
          )}
          <span className={styles.hint}>A row of an Airbnb file belongs to this property through its active title or any previous one.</span>
        </Tile>
      )}
      {dialog}
    </Panel>
  );
}
