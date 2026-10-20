"use client";

/**
 * Admins (dispatch 38): the main admin's page. Kian's rulings of 2026-10-13:
 * one main admin, Kian, adds and removes admins and sets their level — two
 * levels, main admin and admin — and every admin action records which admin
 * did it. (Evening:) admins sign in with their PIN alone; the main admin sets
 * an admin's name when adding them; five wrong PINs from one connection lock
 * sign-in from it for fifteen minutes, a lock the main admin can lift here.
 * (Night:) the main admin sets each admin's PIN when adding them and can
 * change any ordinary admin's; main admins see every admin's PIN, their own
 * included, here; the Add an admin dialog opens on Admin.
 *
 * The list: each admin's name, level, PIN (the four digits, or, for one kept
 * before PINs were readable, what it is), last sign-in and who added them. On
 * an ordinary admin's row: Make main admin, Change PIN, Remove. Kian's ruling
 * of 2026-10-13: a main admin cannot be removed, demoted or given a new PIN
 * by anyone but themselves — so another main admin's row offers nothing, and
 * your own offers Step down and Remove myself while another main admin
 * remains (accountVerdict in model.ts). Your own name and PIN are changed
 * from your name in the header.
 *
 * The PIN the main admin types, adding an admin or changing one's PIN, shows
 * as typed: main admins see every PIN, and they hand this one on.
 *
 * Then the locked connections: when each lock ends and when its last wrong
 * PIN came, with Lift. No address is shown: none is kept, only a keyed hash.
 *
 * Under them, the activity: the newest admin actions, who did each and when.
 *
 * An admin who is not a main admin is told this page is not theirs; the
 * server refuses them its reads and writes as well (403 MAIN_ADMIN_ONLY).
 */

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, RefreshCw, ShieldCheck, UserPlus } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { PinGate, useAdminSession } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { useAsk } from "../components/AskDialog";
import { Dialog } from "../property/editor/controls";
import ed from "../property/editor/editor.module.css";
import { createAdmin, fetchActivity, fetchAdmins, fetchLocks, liftLock, removeAdmin, setAdminLevel, setAdminPin, type AdminResult } from "@/app/lib/admins-client";
import {
  ADMIN_LEVELS,
  ADMIN_LEVEL_LABELS,
  ADMIN_NAME_MAX,
  PIN_LENGTH,
  accountVerdict,
  adminActorWords,
  adminNameProblem,
  describeAdminAction,
  isAdminLevel,
  isReadablePin,
  pinProblem,
  type AccountAction,
  type AdminActionView,
  type AdminLevel,
  type AdminSummary,
  type SignInLockView,
} from "@/app/lib/admins/model";
import shared from "../page.module.css";
import styles from "./page.module.css";

type Load<T> = { kind: "loading" } | { kind: "ready"; data: T } | { kind: "error"; title: string; status: number };

const LEVEL_DOES: Record<AdminLevel, string> = {
  main: "Adds and removes admins",
  admin: "Everything else",
};

/** A PIN shown without digits: the shared one, or one kept before PINs were four digits (set a new one). */
const PIN_WORDS: Record<string, string> = {
  shared: "Shared PIN",
  own: "Needs a new PIN",
  temporary: "Needs a new PIN",
  set: "Needs a new PIN",
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
  const [locks, setLocks] = useState<Load<SignInLockView[]>>({ kind: "loading" });
  const [activity, setActivity] = useState<Load<AdminActionView[]>>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [pinFor, setPinFor] = useState<AdminSummary | null>(null);
  const { notice, show, clear } = useNotice();
  const { ask, dialog } = useAsk();

  useEffect(() => {
    let cancelled = false;
    const settle = <T,>(set: (load: Load<T>) => void) => (r: AdminResult<T>) => {
      if (!cancelled) set(r.ok ? { kind: "ready", data: r.data } : { kind: "error", title: r.title, status: r.status });
    };
    fetchAdmins().then(settle(setAdmins));
    fetchLocks().then(settle(setLocks));
    fetchActivity(100).then(settle(setActivity));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const reload = useCallback(() => {
    setAdmins({ kind: "loading" });
    setLocks({ kind: "loading" });
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

  const lift = async (lock: SignInLockView) => {
    clear();
    setBusy(lock.id);
    const result = await liftLock(lock.id);
    setBusy(null);
    // Gone already (it ended, or was lifted): the list drops it either way.
    if (!result.ok && result.code !== "SIGN_IN_LOCK_NOT_FOUND") return show(failureNotice(result, "Nothing was changed."));
    setLocks((prev) => (prev.kind === "ready" ? { kind: "ready", data: prev.data.filter((l) => l.id !== lock.id) } : prev));
    show({ tone: "success", title: result.ok ? "Lifted. Sign-in from that connection works again." : "That lock had already ended." });
  };

  /** Main admins besides you: while there is one, you may step down or leave. */
  const otherMains = admins.kind === "ready" ? admins.data.filter((a) => a.level === "main" && a.id !== you).length : 0;

  return (
    <div className={shared.container}>
      <AdminHeader current="admins" />

      <main className={shared.main}>
        {/* The page's own buttons, in its head (Kian's ruling of 2026-10-15: none in the navigation). */}
        <PageHead title="Admins">
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
        </PageHead>

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
                    <th>Last sign-in</th>
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
                    const canSetPin = may("set-pin");
                    const canRemove = may("remove");
                    const any = canPromote || canDemote || canSetPin || canRemove;
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
                          {isReadablePin(admin.pin) && admin.pinValue ? (
                            <span className={styles.pinValue} translate="no">
                              {admin.pinValue}
                            </span>
                          ) : (
                            <span className={styles.warn}>{PIN_WORDS[admin.pin ?? ""] ?? admin.pin ?? "None"}</span>
                          )}
                        </td>
                        <td className={styles.whenCell}>
                          <span className={styles.muted}>{admin.lastSignedInAt ? when(admin.lastSignedInAt) : "Never"}</span>
                        </td>
                        <td className={styles.addedCell}>
                          {when(admin.createdAt)}
                          <span className={styles.muted}> · {admin.createdBy?.role === "system" ? "first sign-in" : adminActorWords(admin.createdBy)}</span>
                        </td>
                        <td className={styles.actionCell}>
                          {!any ? (
                            <span className={styles.muted}>{mine ? "Your name and PIN: from your name above" : "Theirs to manage"}</span>
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
                              {canSetPin && (
                                <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => { clear(); setPinFor(admin); }}>
                                  Change PIN…
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

        <section aria-label="Locked connections" className={styles.block}>
          <h2 className={styles.blockTitle}>Locked connections</h2>
          {locks.kind === "loading" ? (
            <p className={styles.muted}>Loading…</p>
          ) : locks.kind === "error" ? (
            <p className={styles.warn} role="alert">
              Could not load the locked connections: {locks.title}
            </p>
          ) : locks.data.length === 0 ? (
            <p className={styles.muted}>None. Five wrong PINs in a row from one connection lock sign-in from it for 15 minutes; twenty in a Toronto day, until lifted here.</p>
          ) : (
            <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Locked until</th>
                    <th>Last try</th>
                    <th className={shared.actionsHeader}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {locks.data.map((lock) => (
                    <tr key={lock.id}>
                      <td className={styles.whenCell}>
                        <span className={`${styles.badge} ${styles.badgeLocked}`}>{lock.lockedUntil === null ? "Until lifted" : when(lock.lockedUntil)}</span>
                      </td>
                      <td className={styles.whenCell}>
                        <span className={styles.muted}>{when(lock.lastFailedAt)}</span>
                      </td>
                      <td className={styles.actionCell}>
                        <button type="button" className={styles.rowAction} disabled={busy !== null} onClick={() => lift(lock)}>
                          {busy === lock.id ? "Lifting…" : "Lift"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

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
          onAdded={(admin) => {
            setAdding(false);
            setAdmins((prev) => (prev.kind === "ready" ? { kind: "ready", data: [...prev.data, admin] } : prev));
            show({ tone: "success", title: `Added ${admin.name ?? "the admin"}.`, detail: "They sign in with the PIN you set, alone." });
          }}
          onUnknown={(title) => {
            setAdding(false);
            show({ tone: "warning", title, detail: "The admin may or may not have been added. Refresh to see." });
          }}
        />
      )}
      {pinFor && (
        <SetPinDialog
          admin={pinFor}
          onClose={() => setPinFor(null)}
          onDone={(row, changed) => {
            setPinFor(null);
            replace(row);
            show({ tone: "success", title: changed ? `${row.name ?? "The admin"}'s PIN is changed.` : "That is their PIN already.", detail: changed ? "They are signed out, and sign in with the new PIN." : "Nothing was changed." });
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

/** Four digits, shown as typed (the main admin sees every PIN, and hands this one on). */
function PinField({ value, onChange, disabled, label }: { value: string; onChange: (v: string) => void; disabled: boolean; label: string }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      maxLength={PIN_LENGTH}
      className={styles.pinInput}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH))}
      aria-label={label}
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
    />
  );
}

/** Kian's ruling of 2026-10-13 (night): the Add an admin dialog opens on Admin, not Main admin. */
const ADD_DIALOG_LEVEL: AdminLevel = "admin";

function AddAdminDialog({ onClose, onAdded, onUnknown }: { onClose: () => void; onAdded: (admin: AdminSummary) => void; onUnknown: (title: string) => void }) {
  const [level, setLevel] = useState<AdminLevel>(ADD_DIALOG_LEVEL);
  const [name, setName] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const problem = adminNameProblem(name) ?? pinProblem(pin);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await createAdmin(name, level, pin);
    setBusy(false);
    if (result.ok) return onAdded(result.data);
    // The list of codes never given out cannot be checked (503): nothing was changed, so no "may or may not".
    if (result.unknown && result.code !== "ADMIN_PIN_DENYLIST_UNKEYED") return onUnknown(result.title);
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
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            maxLength={ADMIN_NAME_MAX}
            autoComplete="off"
            spellCheck={false}
            disabled={busy}
            autoFocus
          />
        </label>
        <label className={styles.field}>
          <span className={styles.label}>PIN</span>
          <PinField
            value={pin}
            onChange={(v) => {
              setPin(v);
              setError(null);
            }}
            disabled={busy}
            label="PIN"
          />
        </label>
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}

function SetPinDialog({ admin, onClose, onDone, onUnknown }: { admin: AdminSummary; onClose: () => void; onDone: (row: AdminSummary, changed: boolean) => void; onUnknown: (title: string) => void }) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const problem = pinProblem(pin);
    if (problem) return setError(problem);
    setBusy(true);
    setError(null);
    const result = await setAdminPin(admin.id, pin);
    setBusy(false);
    if (result.ok) return onDone(result.data.admin, result.data.changed);
    // The list of codes never given out cannot be checked (503): nothing was changed, so no "may or may not".
    if (result.unknown && result.code !== "ADMIN_PIN_DENYLIST_UNKEYED") return onUnknown(result.title);
    setError(result.title);
  };

  return (
    <Dialog
      title={`Change ${admin.name ?? "this admin"}'s PIN`}
      onClose={onClose}
      initialFocus="none"
      actions={
        <>
          <button type="button" className={`${ed.btn} ${ed.btnGhost}`} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="set-pin" className={`${ed.btn} ${ed.btnPrimary}`} disabled={busy || pin.length !== PIN_LENGTH}>
            {busy ? "Saving…" : "Save PIN"}
          </button>
        </>
      }
    >
      <form id="set-pin" className={styles.form} onSubmit={submit}>
        <p>Their PIN stops working at once, and they are signed out.</p>
        <label className={styles.field}>
          <span className={styles.label}>New PIN</span>
          <PinField
            value={pin}
            onChange={(v) => {
              setPin(v);
              setError(null);
            }}
            disabled={busy}
            label="New PIN"
          />
        </label>
        {error && (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
