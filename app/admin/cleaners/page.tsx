"use client";

/**
 * Cleaners: who can log costs, their codes, and whether those codes work.
 *
 * Reads and writes go through /api/admin/cleaners behind the admin session;
 * firestore.rules denies the browser any access to `cleaners` and
 * `cleaner_codes`.
 *
 * By Kian's ruling of 2026-09-28 a cleaner's code is visible to admins at any
 * time and can be changed: each row shows the current code, and "Change
 * code" takes four typed digits or draws a random code. The server refuses
 * the admin PIN, the reserved list and any code issued before; the old code
 * stops working at once and is never given out again.
 *
 * A create whose outcome is unknown — no answer, or an answer that does not
 * say — is reported as such and never retried: a retry could create the same
 * person twice. Status and code changes are not optimistic either: a row
 * changes only to what the server says it stored.
 *
 * No pagination. The whole collection is one response.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, KeyRound, RefreshCw, UserPlus, Users } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice } from "../components/Notice";
import {
  changeCleanerCode,
  changeCleanerStatus,
  createCleaner,
  fetchCleaners,
  type CleanerResult,
  type CodeRequest,
} from "@/app/lib/cleaners-client";
import {
  CLEANER_STATUS_LABELS,
  CODE_PATTERN,
  LIMITS,
  isCleanerStatus,
  type CleanerStatus,
  type CleanerSummary,
} from "@/app/lib/cleaners/model";
import { Absent, FieldText, When } from "../leads/lead-display";
import shared from "../page.module.css";
import styles from "./page.module.css";

type CleanerFailure = Extract<CleanerResult<unknown>, { ok: false }>;

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; cleaners: CleanerSummary[] }
  | { kind: "error"; title: string; detail?: string; status: number };

/** The cleaner whose code is being changed, as the row showed them. */
interface CodeEditor {
  id: string;
  name: string;
  current: string | null;
}

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

const CODE_CHANGE_EFFECT =
  "The old code stops working at once and is never given out again. Any phone signed in with it is signed out.";

export default function CleanersPage() {
  return (
    <PinGate>
      <Cleaners />
    </PinGate>
  );
}

function Cleaners() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  /** The name of a create whose outcome is unknown. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  /** The one save in flight: a status or a code change, for one cleaner. */
  const [saving, setSaving] = useState<{ id: string; what: "status" | "code" } | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const codeInputRef = useRef<HTMLInputElement>(null);
  const { notice, show: showNotice, clear: clearNotice } = useNotice();

  useEffect(() => {
    let cancelled = false;
    fetchCleaners().then((result) => {
      if (cancelled) return;
      setList(
        result.ok
          ? { kind: "ready", cleaners: result.data }
          : { kind: "error", title: result.title, detail: result.detail, status: result.status },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = () => {
    setList({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  // Opening the editor puts the cursor in the code field.
  const editingId = editor?.id ?? null;
  useEffect(() => {
    if (editingId !== null) codeInputRef.current?.focus();
  }, [editingId]);

  /** Put the cleaner the server returned into the list in place of the row it had. */
  const replaceRow = (stored: CleanerSummary) => {
    setList((prev) =>
      prev.kind === "ready"
        ? { kind: "ready", cleaners: prev.cleaners.map((c) => (c.id === stored.id ? stored : c)) }
        : prev,
    );
  };

  const name = draft.trim();
  const busy = saving !== null;
  const canCreate = name !== "" && !creating;

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    clearNotice();
    setUnconfirmed(null);
    setCreating(true);
    const result = await createCleaner(name);
    setCreating(false);

    if (result.ok) {
      const created = result.data.cleaner;
      showNotice({
        tone: "success",
        title: `Created ${displayName(created.name ?? name)}.`,
        detail: created.code ? `Their code is ${created.code}.` : undefined,
      });
      setDraft("");
      reload();
      return;
    }
    if (result.unknown) {
      setUnconfirmed(name);
      setDraft("");
      return;
    }
    showNotice({ tone: "error", title: result.title, detail: describeFailure(result, "Nothing was created.") });
  };

  const changeStatus = async (cleaner: CleanerSummary, target: CleanerStatus) => {
    if (busy) return;
    const who = displayName(cleaner.name);
    const question =
      target === "deactivated"
        ? `Deactivate ${who}? Their code stops working at once and any signed-in phone is signed out. Their entries keep their name.`
        : `Reactivate ${who}? Their existing code works again. Phones signed in before are still signed out.`;
    if (!window.confirm(question)) return;

    clearNotice();
    setSaving({ id: cleaner.id, what: "status" });
    const result = await changeCleanerStatus(cleaner.id, target);
    setSaving(null);

    if (!result.ok) {
      showNotice(
        result.unknown
          ? {
              tone: "warning",
              title: "The change may or may not have been saved. Reload to see the stored status.",
              detail: result.title,
            }
          : { tone: "error", title: result.title, detail: describeStatusFailure(result) },
      );
      return;
    }

    replaceRow(result.data.cleaner);
    const label = CLEANER_STATUS_LABELS[target].toLowerCase();
    showNotice(
      result.data.changed
        ? { tone: "success", title: `${target === "deactivated" ? "Deactivated" : "Reactivated"} ${who}.` }
        : { tone: "info", title: `Nothing was changed: ${who} was already ${label}.` },
    );
  };

  const openEditor = (cleaner: CleanerSummary) => {
    if (busy) return;
    clearNotice();
    setCodeDraft("");
    setEditor({
      id: cleaner.id,
      name: displayName(cleaner.name),
      current: cleaner.code !== null && CODE_PATTERN.test(cleaner.code) ? cleaner.code : null,
    });
  };

  const closeEditor = () => {
    setEditor(null);
    setCodeDraft("");
  };

  const saveCode = async (target: CodeEditor, request: CodeRequest) => {
    if (busy) return;
    const was = target.current ? ` (${target.current})` : "";
    const question =
      "code" in request
        ? `Change ${target.name}'s code${target.current ? ` from ${target.current}` : ""} to ${request.code}? ${CODE_CHANGE_EFFECT}`
        : `Give ${target.name} a new code, chosen at random? The old code${was} stops working at once and is never given out again. Any phone signed in with it is signed out.`;
    if (!window.confirm(question)) return;

    clearNotice();
    setSaving({ id: target.id, what: "code" });
    const result = await changeCleanerCode(target.id, request);
    setSaving(null);

    if (!result.ok) {
      showNotice(
        result.unknown
          ? {
              tone: "warning",
              title: "The code change may or may not have been saved. Reload to see the stored code.",
              detail: result.title,
            }
          : { tone: "error", title: result.title, detail: describeFailure(result, "The code was not changed.") },
      );
      return;
    }

    const stored = result.data.cleaner;
    replaceRow(stored);
    closeEditor();
    showNotice(
      result.data.changed
        ? {
            tone: "success",
            title: `${target.name}'s code is now ${stored.code}.`,
            detail: target.current ? `${target.current} no longer works.` : undefined,
          }
        : { tone: "info", title: `Nothing was changed: ${stored.code} is already ${target.name}'s code.` },
    );
  };

  const submitTypedCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor && CODE_PATTERN.test(codeDraft)) saveCode(editor, { code: codeDraft });
  };

  return (
    <div className={shared.container}>
      {/* ── Header ── the shared one; this page's action is Refresh */}
      <AdminHeader current="cleaners">
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={list.kind === "loading"}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
      </AdminHeader>

      <main className={shared.main}>
        {/* ── Notices (creates, status and code changes) ── */}
        <NoticeBanner notice={notice} onDismiss={clearNotice} className={shared.pageNotice} />

        {/* Kept apart from the Notice slot, so the next notice cannot replace it. */}
        {unconfirmed !== null && (
          <NoticeBanner
            className={shared.pageNotice}
            notice={{
              tone: "warning",
              title: "The cleaner may have been created.",
              detail: `Reload the list: if '${unconfirmed}' appears, their code is in their row.`,
            }}
          />
        )}

        {list.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading cleaners…</p>
          </div>
        ) : list.kind === "error" ? (
          /* A failed read is NOT an empty list. Never offer to create here —
             the cleaner may already exist. */
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load cleaners</h2>
            <p>
              It is not empty — it has not loaded.
              {(list.status === 401 || list.status === 403) && ` ${SESSION_HINT}`}
            </p>
            <code className={shared.loadErrorDetail}>
              {list.title}
              {list.detail ? ` ${list.detail}` : ""}
            </code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <>
            {/* ── Create ── */}
            <form className={styles.createRow} onSubmit={submit}>
              <label htmlFor="new-cleaner-name" className={styles.createLabel}>
                New cleaner
              </label>
              <input
                id="new-cleaner-name"
                type="text"
                className={styles.createInput}
                placeholder="Name"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                maxLength={LIMITS.NAME_MAX}
                autoComplete="off"
                spellCheck={false}
                disabled={creating}
              />
              <button
                type="submit"
                className={`${shared.btnPrimary} ${styles.createBtn}`}
                disabled={!canCreate}
              >
                <UserPlus size={16} />
                <span>{creating ? "Creating…" : "Create cleaner"}</span>
              </button>
            </form>

            {/* ── Change a code ── */}
            {editor && (
              <form
                className={styles.codeEditor}
                onSubmit={submitTypedCode}
                aria-labelledby="code-editor-title"
              >
                <h2 id="code-editor-title" className={styles.codeEditorTitle}>
                  <KeyRound size={16} aria-hidden />
                  <span>New code for {editor.name}</span>
                </h2>
                <p className={styles.codeEditorNote}>
                  {editor.current ? (
                    <>
                      Current code: <span className={styles.codeInline}>{editor.current}</span>.{" "}
                    </>
                  ) : (
                    "No code on record. "
                  )}
                  {CODE_CHANGE_EFFECT}
                </p>
                <div className={styles.codeEditorRow}>
                  <label htmlFor="new-cleaner-code" className={styles.createLabel}>
                    Four digits
                  </label>
                  <input
                    id="new-cleaner-code"
                    ref={codeInputRef}
                    type="text"
                    inputMode="numeric"
                    pattern="[0-9]{4}"
                    maxLength={4}
                    autoComplete="off"
                    spellCheck={false}
                    className={styles.codeInput}
                    value={codeDraft}
                    onChange={(e) => setCodeDraft(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    disabled={busy}
                  />
                  <button
                    type="submit"
                    className={`${shared.btnPrimary} ${styles.createBtn}`}
                    disabled={busy || !CODE_PATTERN.test(codeDraft)}
                  >
                    {saving?.what === "code" ? "Saving…" : "Save code"}
                  </button>
                  <span className={styles.codeEditorOr}>or</span>
                  <button
                    type="button"
                    className={styles.btnGhost}
                    onClick={() => saveCode(editor, { generate: true })}
                    disabled={busy}
                  >
                    Generate one
                  </button>
                  <button type="button" className={styles.btnGhost} onClick={closeEditor} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* ── List ── */}
            {list.cleaners.length === 0 ? (
              <div className={shared.empty}>
                <Users size={48} strokeWidth={1} />
                <h2>No cleaners yet</h2>
                <p>Create one above.</p>
              </div>
            ) : (
              <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
                <table className={shared.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Code</th>
                      <th>Status</th>
                      <th>Created</th>
                      <th>Status changed</th>
                      <th>ID</th>
                      <th className={shared.actionsHeader}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.cleaners.map((cleaner) => {
                      const next = nextStatus(cleaner.status);
                      return (
                        <tr key={cleaner.id}>
                          <td className={styles.nameCell}>
                            <FieldText value={cleaner.name} />
                          </td>
                          <td>
                            <CodeCell code={cleaner.code} />
                          </td>
                          <td>
                            <StatusBadge status={cleaner.status} />
                          </td>
                          <td className={styles.whenCell}>
                            <When iso={cleaner.createdAt} />
                          </td>
                          <td className={styles.whenCell}>
                            <When iso={cleaner.statusChangedAt} />
                          </td>
                          <td>
                            <span className={styles.mono}>{cleaner.id}</span>
                          </td>
                          <td className={styles.actionCell}>
                            <button
                              type="button"
                              className={styles.rowAction}
                              disabled={busy}
                              onClick={() => openEditor(cleaner)}
                            >
                              {cleaner.code === null ? "Set code" : "Change code"}
                            </button>
                            {/* No status action for a status that is neither: nothing to flip it to. */}
                            {next && (
                              <button
                                type="button"
                                className={styles.rowAction}
                                disabled={busy}
                                onClick={() => changeStatus(cleaner, next)}
                              >
                                {saving?.id === cleaner.id && saving.what === "status"
                                  ? "Saving…"
                                  : next === "deactivated"
                                    ? "Deactivate"
                                    : "Reactivate"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
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

/** A stored code. None on record is said in words; anything but four digits is shown as stored, marked. */
function CodeCell({ code }: { code: string | null }) {
  if (code === null) return <Absent label="None on record" />;
  if (CODE_PATTERN.test(code)) {
    return (
      <span className={styles.code} translate="no">
        {code}
      </span>
    );
  }
  return (
    <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not four digits">
      {code.trim() === "" ? "Empty" : code}
    </span>
  );
}

const STATUS_CLASS: Record<CleanerStatus, string> = {
  active: styles.badgeActive,
  deactivated: styles.badgeDeactivated,
};

/** A stored status. One outside the two is shown as stored, marked as unexpected. */
function StatusBadge({ status }: { status: string | null }) {
  if (status === null) return <Absent />;
  if (isCleanerStatus(status)) {
    return (
      <span className={`${styles.badge} ${STATUS_CLASS[status]}`}>{CLEANER_STATUS_LABELS[status]}</span>
    );
  }
  return (
    <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not one of active or deactivated">
      {status.trim() === "" ? "Empty" : status}
    </span>
  );
}

/** The status the row's action moves to, or null when the stored status is neither. */
function nextStatus(status: string | null): CleanerStatus | null {
  if (status === "active") return "deactivated";
  if (status === "deactivated") return "active";
  return null;
}

/** A name to put in a sentence. */
function displayName(name: string | null): string {
  return name !== null && name.trim() !== "" ? name : "this cleaner";
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** A refusal's detail, with what it means for a signed-out admin. */
function describeFailure(failure: CleanerFailure, nothingDone: string): string | undefined {
  const parts = failure.detail ? [sentence(failure.detail)] : [];
  if (failure.status === 401 || failure.status === 403) parts.push(SESSION_HINT, nothingDone);
  return parts.join(" ") || undefined;
}

function describeStatusFailure(failure: CleanerFailure): string {
  const why = failure.detail ? `${sentence(failure.detail)} ` : "";
  if (failure.status === 401 || failure.status === 403) {
    return `${why}${SESSION_HINT} The status was not changed.`;
  }
  // The application answered with a failure after the request reached it:
  // do not claim the write did not land.
  if (failure.status >= 500) return `${why}Reload to see the stored status.`;
  return `${why}(HTTP ${failure.status}) The status was not changed.`;
}
