"use client";

/**
 * Admins (dispatch 38): the main admin's page. Kian's rulings of 2026-10-13:
 * one main admin, Kian, adds and removes admins and sets their level — two
 * levels, main admin and admin; each admin signs in with their own PIN; five
 * wrong tries lock that PIN for fifteen minutes; every admin action records
 * which admin did it.
 *
 * The list: each admin's name, level, PIN (their own, a temporary one they
 * have still to replace, or the shared PIN), sign-in (locked until when, wrong
 * tries so far, or when they last signed in) and who added them. On an
 * admin's row: Make main admin, a new temporary PIN, Unlock while a lock or a
 * count holds, and Remove. Kian's ruling of 2026-10-13: a main admin cannot be
 * removed, demoted or given a new PIN by anyone but themselves — so another
 * main admin's row offers only Unlock, and your own offers Step down and
 * Remove myself while another main admin remains (accountVerdict in
 * model.ts). Your PIN is changed from your name in the header.
 *
 * Under it, the activity: the newest admin actions, who did each and when.
 *
 * An admin who is not a main admin is told this page is not theirs; the
 * server refuses them its reads and writes as well (403 MAIN_ADMIN_ONLY).
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, Dices, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PinGate, useAdminSession } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { useAsk } from "../components/AskDialog";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import {
  createAdmin,
  fetchActivity,
  fetchAdmins,
  giveNewPin,
  lockTimeWords,
  removeAdmin,
  setAdminLevel,
  suggestPin,
  unlockAdmin,
  type AdminResult,
} from "@/app/lib/admins-client";
import {
  ADMIN_LEVELS,
  ADMIN_LEVEL_LABELS,
  ADMIN_NAME_MAX,
  PIN_LENGTH,
  accountVerdict,
  adminActorWords,
  describeAdminAction,
  isAdminLevel,
  isTooEasyPin,
  newPinProblem,
  type AccountAction,
  type AdminActionView,
  type AdminLevel,
  type AdminSummary,
} from "@/app/lib/admins/model";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; status: number };

const LEVEL_DOES: Record<AdminLevel, string> = {
  main: "Adds and removes admins",
  admin: "Everything else",
};

const PIN_WORDS: Record<string, string> = {
  own: "Their own",
  temporary: "Temporary",
  shared: "Shared PIN",
};

export default function AdminsPage() {
  return (
    <PinGate>
      <Admins />
    </PinGate>
  );
}

function Admins() {
  const session = useAdminSession();
  if (!session) return null;
  if (session.admin.level !== "main") {
    return (
      <div className={shared.container}>
        <AdminHeader current="admins" title="Admins" />
        <main className={shared.main}>
          <div className={shared.empty} role="alert">
            <ShieldCheck size={48} strokeWidth={1} />
            <h2>Only a main admin manages admins</h2>
          </div>
        </main>
      </div>
    );
  }
  return <AdminsList />;
}

/** When, in Toronto: "Oct 13, 4:32 pm". */
function when(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date
    .toLocaleString("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    .replace("a.m.", "am")
    .replace("p.m.", "pm");
}

function failureNotice(result: Extract<AdminResult<unknown>, { ok: false }>, nothing: string): Notice {
  if (result.unknown) return { tone: "warning", title: result.title, detail: "It may or may not have been saved. Reload to see." };
  return { tone: "error", title: result.title, detail: result.status === 401 ? "Your session has ended: reload and sign in again." : nothing };
}

function AdminsList() {
  const session = useAdminSession();
  const you = session?.admin.id ?? null;
  const [admins, setAdmins] = useState<Load<AdminSummary[]>>({ kind: "loading" });
  const [activity, setActivity] = useState<Load<AdminActionView[]>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<AdminSummary | null>(null);
  const { notice, show, clear } = useNotice();
  const { ask, dialog } = useAsk();

  useEffect(() => {
    let cancelled = false;
    fetchAdmins().then((r) => !cancelled && setAdmins(r.ok ? { kind: "ready", data: r.data } : { kind: "error", title: r.title, status: r.status }));
    fetchActivity(100).then((r) => !cancelled && setActivity(r.ok ? { kind: "ready", data: r.data } : { kind: "error", title: r.title, status: r.status }));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setAdmins({ kind: "loading" });
    setActivity({ kind: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  const replace = (row: AdminSummary) => setAdmins((prev) => (prev.kind === "ready" ? { kind: "ready", data: prev.data.map((a) => (a.id === row.id ? row : a)) } : prev));

  const changeLevel = async (admin: AdminSummary, level: AdminLevel) => {
    const name = admin.name ?? "this admin";
    const self = admin.id === you;
    const yes = await ask(
      level === "main"
        ? { title: `Make ${name} a main admin?`, lines: ["They can then add and remove admins and give new PINs.", "Only they can step down or leave: you cannot undo this."], confirm: "Make main admin" }
        : { title: "Step down to admin?", lines: ["You keep everything else; the Admins page closes to you.", "Only a main admin can make you one again."], confirm: "Step down" },
    );
    if (!yes) return;
    clear();
    setBusy(admin.id);
    const result = await setAdminLevel(admin.id, level);
    setBusy(null);
    if (!result.ok) return show(failureNotice(result, "Nothing was changed."));
    if (self && session) return session.update({ ...session.admin, level });
    replace(result.data.admin);
    show({ tone: "success", title: `${name} is now a main admin.` });
  };

  const unlock = async (admin: AdminSummary) => {
    clear();
    setBusy(admin.id);
    const result = await unlockAdmin(admin.id);
    setBusy(null);
    if (!result.ok) return show(failureNotice(result, "Nothing was changed."));
    replace(result.data.admin);
    show({ tone: "success", title: result.data.changed ? `${admin.name ?? "The admin"} can sign in again.` : "Nothing was locked." });
  };

  const remove = async (admin: AdminSummary) => {
    const name = admin.name ?? "this admin";
    const self = admin.id === you;
    const yes = await ask(
      self
        ? { title: "Remove yourself?", lines: ["You are signed out at once and cannot sign in again. What you did keeps your name."], confirm: "Remove myself", danger: true }
        : { title: `Remove ${name}?`, lines: ["They are signed out at once and cannot sign in again. What they did keeps their name.", "Their name can be given to someone new."], confirm: "Remove", danger: true },
    );
    if (!yes) return;
    clear();
    setBusy(admin.id);
    const result = await removeAdmin(admin.id);
    setBusy(null);
    if (!result.ok) return show(failureNotice(result, "Nothing was removed."));
    if (self && session) return void session.signOut();
    setAdmins((prev) => (prev.kind === "ready" ? { kind: "ready", data: prev.data.filter((a) => a.id !== admin.id) } : prev));
    show({ tone: "success", title: `Removed ${name}.` });
  };

  /** Main admins besides you: while there is one, you may step down or leave. */
  const otherMains = admins.kind === "ready" ? admins.data.filter((a) => a.level === "main" && a.id !== you).length : 0;

  return (
    <div className={shared.container}>
      <AdminHeader current="admins">
        <button type="button" className={shared.btnGhost} onClick={reload} disabled={admins.kind === "loading"}>
          <RefreshCw size={15} aria-hidden />
          <span>Refresh</span>
        </button>
        {admins.kind === "ready" && (
          <button type="button" className={shared.btnPrimary} onClick={() => { clear(); setAdding(true); }}>
            <UserPlus size={16} aria-hidden />
            <span>Add admin</span>
          </button>
        )}
      </AdminHeader>

      <main className={shared.main}>
        <NoticeBanner notice={notice} onDismiss={clear} className={shared.pageNotice} />

        {admins.kind === "loading" ? (
          <div className={shared.loading}>
            <div className={shared.spinner} />
            <p>Loading admins…</p>
          </div>
        ) : admins.kind === "error" ? (
          <div className={`${shared.empty} ${shared.loadError}`} role="alert">
            <AlertTriangle size={48} strokeWidth={1} />
            <h2>Could not load the admins</h2>
            <code className={shared.loadErrorDetail}>{admins.title}</code>
            <button type="button" className={shared.btnPrimary} onClick={reload}>
              <RefreshCw size={18} />
              <span>Retry</span>
            </button>
          </div>
        ) : (
          <section aria-label="Admins" className={styles.block}>
            <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Level</th>
                    <th>PIN</th>
                    <th>Sign-in</th>
                    <th>Added</th>
                    <th className={shared.actionsHeader}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {admins.data.map((admin) => {
                    const mine = admin.id === you;
                    const level = isAdminLevel(admin.level) ? admin.level : null;
                    // What may be done to this row (Kian's ruling: a main admin's account is theirs alone).
                    const target = { self: mine, targetIsMain: level === "main" };
                    const may = (action: AccountAction) => accountVerdict(action, target, otherMains) === "ok";
                    const canPromote = level === "admin";
                    const canDemote = level === "main" && may("demote");
                    const canNewPin = may("new-pin");
                    const canUnlock = Boolean(admin.lockedUntil) || admin.failedTries > 0;
                    const canRemove = may("remove");
                    const any = canPromote || canDemote || canNewPin || canUnlock || canRemove;
                    return (
                      <tr key={admin.id}>
                        <td className={styles.nameCell}>
                          {admin.name ?? <span className={styles.muted}>No name</span>}
                          {mine && <span className={`${styles.badge} ${styles.badgeYou}`}>You</span>}
                        </td>
                        <td>
                          <span className={`${styles.badge} ${level === "main" ? styles.badgeMain : styles.badgeAdmin}`}>{level ? ADMIN_LEVEL_LABELS[level] : admin.level ?? "None"}</span>
                        </td>
                        <td>
                          <span className={admin.pin === "own" ? undefined : styles.warn}>{PIN_WORDS[admin.pin ?? ""] ?? admin.pin ?? "None"}</span>
                        </td>
                        <td>
                          {admin.lockedUntil ? (
                            <span className={`${styles.badge} ${styles.badgeLocked}`}>Locked until {lockTimeWords(admin.lockedUntil)}</span>
                          ) : admin.failedTries > 0 ? (
                            <span className={styles.warn}>{admin.failedTries === 1 ? "1 wrong try" : `${admin.failedTries} wrong tries`}</span>
                          ) : (
                            <span className={styles.muted}>{admin.lastSignedInAt ? `Last ${when(admin.lastSignedInAt)}` : "Never signed in"}</span>
                          )}
                        </td>
                        <td className={styles.addedCell}>
                          {when(admin.createdAt)}
                          <span className={styles.muted}> · {admin.createdBy?.role === "system" ? "first sign-in" : adminActorWords(admin.createdBy)}</span>
                        </td>
                        <td className={styles.actionCell}>
                          {!any ? (
                            <span className={styles.muted}>{mine ? "Change your PIN from your name above" : "Theirs to manage"}</span>
                          ) : (
                            <>
                              {canPromote && (
                                <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => changeLevel(admin, "main")}>
                                  Make main admin
                                </button>
                              )}
                              {canDemote && (
                                <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => changeLevel(admin, "admin")}>
                                  Step down
                                </button>
                              )}
                              {canNewPin && (
                                <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => { clear(); setPinFor(admin); }}>
                                  New PIN…
                                </button>
                              )}
                              {canUnlock && (
                                <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => unlock(admin)}>
                                  Unlock
                                </button>
                              )}
                              {canRemove && (
                                <button type="button" className={`${styles.rowAction} ${styles.rowActionDanger}`} disabled={busy !== null} onClick={() => remove(admin)}>
                                  {busy === admin.id ? "Saving…" : mine ? "Remove myself…" : "Remove…"}
                                </button>
                              )}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section aria-label="Activity" className={styles.block}>
          <h2 className={styles.blockTitle}>Activity</h2>
          {activity.kind === "loading" ? (
            <p className={styles.muted}>Loading…</p>
          ) : activity.kind === "error" ? (
            <p className={styles.warn} role="alert">
              Could not load the activity: {activity.title}
            </p>
          ) : activity.data.length === 0 ? (
            <p className={styles.muted}>No admin actions recorded yet.</p>
          ) : (
            <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Who</th>
                    <th>What</th>
                    <th>Where</th>
                  </tr>
                </thead>
                <tbody>
                  {activity.data.map((line) => (
                    <tr key={line.id}>
                      <td className={styles.whenCell}>{when(line.at)}</td>
                      <td className={styles.nameCell}>{line.admin.name ?? line.admin.id ?? "—"}</td>
                      <td>{describeAdminAction(line.method, line.path) ?? `${line.method ?? ""} ${line.path ?? ""}`}</td>
                      <td className={styles.mono}>{line.path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>

      {adding && (
        <AddAdminDialog
          onClose={() => setAdding(false)}
          onAdded={(admin, pin) => {
            setAdding(false);
            setAdmins((prev) => (prev.kind === "ready" ? { kind: "ready", data: [...prev.data, admin] } : prev));
            show({ tone: "success", title: `Added ${admin.name ?? "the admin"}. Temporary PIN ${pin}.`, detail: "They choose their own when they first sign in." });
          }}
          onUnknown={(title) => {
            setAdding(false);
            show({ tone: "warning", title, detail: "The admin may or may not have been added. Refresh to see." });
          }}
        />
      )}
      {pinFor && (
        <NewPinDialog
          admin={pinFor}
          onClose={() => setPinFor(null)}
          onDone={(row, pin) => {
            setPinFor(null);
            replace(row);
            show({ tone: "success", title: `${row.name ?? "The admin"}'s temporary PIN is ${pin}.`, detail: "They are signed out, and choose their own PIN when they next sign in." });
          }}
          onUnknown={(title) => {
            setPinFor(null);
            show({ tone: "warning", title, detail: "The PIN may or may not have changed. Refresh to see." });
          }}
        />
      )}
      {dialog}
    </div>
  );
}

// ─── Dialogs ───────────────────────────────────────────────────

function PinField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled: boolean }) {
  return (
    <div className={styles.pinRow}>
      <input
        type="text"
        inputMode="numeric"
        maxLength={PIN_LENGTH}
        className={styles.codeInput}
        value={value}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
        aria-label="Temporary PIN"
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
      />
      <button type="button" className={styles.btnGhost} onClick={() => onChange(suggestPin(isTooEasyPin))} disabled={disabled}>
        <Dices size={15} aria-hidden />
        <span>Generate</span>
      </button>
    </div>
  );
}

function AddAdminDialog({ onClose, onAdded, onUnknown }: { onClose: () => void; onAdded: (admin: AdminSummary, pin: string) => void; onUnknown: (title: string) => void }) {
  const [level, setLevel] = useState<AdminLevel>("admin");
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const problem = name.trim() === "" ? "Name the admin." : newPinProblem(pin);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await createAdmin(name.trim(), level, pin);
    setBusy(false);
    if (result.ok) return onAdded(result.data, pin);
    if (result.unknown) return onUnknown(result.title);
    setError(result.title);
  };

  return (
    <Dialog
      title="Add an admin"
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="add-admin" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy || name.trim() === "" || pin.length !== PIN_LENGTH}>
            {busy ? "Adding…" : `Add ${level === "main" ? "main admin" : "admin"}`}
          </button>
        </>
      }
    >
      <form id="add-admin" className={styles.form} onSubmit={submit}>
        <fieldset className={styles.levelField} disabled={busy}>
          <legend className={styles.label}>Level</legend>
          <div className={styles.levelCards}>
            {ADMIN_LEVELS.map((value) => (
              <label key={value} className={`${styles.levelCard} ${level === value ? styles.levelCardOn : ""}`}>
                <input type="radio" name="admin-level" value={value} checked={level === value} onChange={() => setLevel(value)} className={styles.levelRadio} />
                <span className={styles.levelName}>{ADMIN_LEVEL_LABELS[value]}</span>
                <span className={styles.levelDoes}>{LEVEL_DOES[value]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            type="text"
            className={styles.nameInput}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={ADMIN_NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </label>
        <div className={styles.field}>
          <span className={styles.label}>Temporary PIN</span>
          <PinField value={pin} onChange={setPin} disabled={busy} />
        </div>
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function NewPinDialog({ admin, onClose, onDone, onUnknown }: { admin: AdminSummary; onClose: () => void; onDone: (row: AdminSummary, pin: string) => void; onUnknown: (title: string) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const problem = newPinProblem(pin);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await giveNewPin(admin.id, pin);
    setBusy(false);
    if (result.ok) return onDone(result.data.admin, pin);
    if (result.unknown) return onUnknown(result.title);
    setError(result.title);
  };

  return (
    <Dialog
      title={`New PIN for ${admin.name ?? "this admin"}`}
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="new-pin" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy || pin.length !== PIN_LENGTH}>
            {busy ? "Saving…" : "Give this PIN"}
          </button>
        </>
      }
    >
      <form id="new-pin" className={styles.form} onSubmit={submit}>
        <p>They are signed out, any lock is cleared, and they choose their own PIN when they next sign in.</p>
        <div className={styles.field}>
          <span className={styles.label}>Temporary PIN</span>
          <PinField value={pin} onChange={setPin} disabled={busy} />
        </div>
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

