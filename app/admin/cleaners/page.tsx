"use client";

/**
 * Team: the cleaners and handymen who can log costs, their codes, and
 * whether those codes work. Since dispatch 24 an account has a role — a
 * cleaner logs receipts, a handyman logs work — chosen when it is created
 * (the page's "Add team member", NewMemberDialog.tsx) and shown in its
 * row; both come from the one code index. The admin types the code when
 * creating (Kian, dispatch 23H), or fills it with "Generate". Beside each
 * cleaner, their last 90 days of receipts in words (costs/patterns.ts), the
 * $150–200 band always named, read from the same cost list the costs page
 * reads. That second read failing shows as "could not be read", never as
 * nothing sent.
 *
 * Reads and writes go through /api/admin/cleaners behind the admin session;
 * firestore.rules denies the browser any access to `cleaners` and
 * `cleaner_codes`.
 *
 * By Kian's ruling of 2026-09-28 a cleaner's code is visible to admins at any
 * time and can be changed: each row shows the current code, and "Change
 * code" takes four typed digits or draws a random code. The server refuses
 * an admin's PIN and a code an active account holds, each in one plain line
 * that says why; any other code is free (Kian's ruling of 2026-10-02), easy
 * codes such as 1234 or 0000 included (Kian's rulings of 2026-10-17), a
 * deactivated account that held it then having none. The old code stops
 * working at once.
 *
 * A create whose outcome is unknown — no answer, or an answer that does not
 * say — is reported as such and never retried: a retry could create the same
 * person twice. Status and code changes are not optimistic either: a row
 * changes only to what the server says it stored.
 *
 * "Delete…" (Kian's ruling of 2026-10-02) deletes a cleaner or a handyman
 * for good: the confirmation names what is lost — the account, its code, any
 * signed-in phone — and how many entries they logged and cleanings they did,
 * which stay on the ledger under the name they were logged with (dispatch
 * 37B: a deleted cleaner's cleanings still read). A row leaves the list only
 * once the server says the account is gone.
 *
 * "Set rate" (dispatch 37B, Kian's ruling of 2026-10-13): each cleaner has one
 * default rate for a cleaning. A cleaning's amount starts from what that
 * cleaner was last paid for the property, or this rate if none; the admin
 * changes it freely when logging. A handyman has no rate.
 *
 * Pay (Team pay, Kian's rulings of 2026-10-15): each row shows Earned, Paid
 * and Balance, worked out by the one function (app/lib/pay/balance.ts) from
 * the cost list this page already reads and every payment; the name and
 * "Pay" open the person's pay (PayView.tsx) at ?pay={id}, drawn from what
 * this page holds, so opening a person reads nothing more. A member whose
 * balance is not zero cannot be deleted: the page says so, naming the
 * balance, and the server refuses it too. A failed read shows "could not be
 * read", never a balance that might be wrong. The ID moved to the person's
 * pay, and every action but Pay behind the row's "⋯" (RowMenu.tsx), to make
 * room.
 *
 * No pagination. The whole collection is one response.
 */

import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { AlertTriangle, KeyRound, RefreshCw, UserPlus, Users } from "lucide-react";
import { AdminHeader } from "../components/AdminHeader";
import { PageHead } from "../components/PageHead";
import { PinGate } from "../components/PinGate";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { fetchCosts } from "@/app/lib/costs-client";
import { distributionText, watchList, type CleanerPattern } from "@/app/lib/costs/patterns";
import type { CostEntryView } from "@/app/lib/cleaners/model";
import type { CleaningView } from "@/app/lib/cleanings/model";
import { fetchPayments } from "@/app/lib/pay-client";
import { balanceWords, memberPay, type MemberPay } from "@/app/lib/pay/balance";
import type { PaymentView } from "@/app/lib/pay/model";
import { formatCents } from "@/app/lib/cleaners/model";
import { torontoDayOf } from "@/app/lib/costs/report";
import {
  changeCleanerCode,
  changeCleanerStatus,
  createCleaner,
  deleteCleaner,
  fetchCleanerLocks,
  fetchCleaners,
  fetchUnmarkedJobs,
  liftCleanerLock,
  setDefaultRate,
  suggestCode,
  type CleanerResult,
  type CodeRequest,
} from "@/app/lib/cleaners-client";
import type { SignInLockView } from "@/app/lib/admins/model";
import type { UnmarkedJob } from "@/app/lib/schedule/model";
import { dayText } from "@/app/lib/availability/days";
import {
  CLEANER_ROLE_LABELS,
  CLEANER_STATUS_LABELS,
  CODE_PATTERN,
  isCleanerRole,
  isCleanerStatus,
  type CleanerRole,
  type CleanerStatus,
  type CleanerSummary,
} from "@/app/lib/cleaners/model";
import { Absent, FieldText } from "../leads/lead-display";
import { NewMemberDialog } from "./NewMemberDialog";
import { PayView, plainClick } from "./PayView";
import { RowMenu } from "./RowMenu";
import { useAsk } from "../components/AskDialog";
import shared from "../page.module.css";
import styles from "./page.module.css";

type CleanerFailure = Extract<CleanerResult<unknown>, { ok: false }>;

type ListState =
  | { kind: "loading" }
  | { kind: "ready"; cleaners: CleanerSummary[] }
  | { kind: "error"; title: string; detail?: string; status: number };

/** The cost list's read, for the 90-day distributions, how many entries each member logged, and their pay: never shown as "nothing" when it failed. */
type PatternsState = { kind: "loading" } | { kind: "ready"; patterns: CleanerPattern[]; entries: CostEntryView[]; cleanings: CleaningView[] } | { kind: "error"; title: string };

/** Every payment (Team pay, 2026-10-15): with the cost list, what each row's Earned, Paid and Balance are worked out from. */
type PaymentsState = { kind: "loading" } | { kind: "ready"; payments: PaymentView[]; unreadable: number } | { kind: "error"; title: string };

/** A member's pay as the row shows it: worked out, still loading, or not readable — never a guess. */
type RowPay = { kind: "ready"; pay: MemberPay; unreadable: number } | { kind: "loading" } | { kind: "error"; title: string };

/** The cleaner whose code is being changed, as the row showed them. */
interface CodeEditor {
  id: string;
  name: string;
  current: string | null;
}

const SESSION_HINT = "Your admin session may have expired — reload and sign in again.";

const CODE_CHANGE_EFFECT = "The old code stops working at once. Any phone signed in with it is signed out.";

/** "Lake View (Oct 16), City Skyline (Oct 17)": jobs by property and checkout day. */
const jobsWords = (jobs: UnmarkedJob[]) => jobs.map((job) => `${job.propertyName ?? "a property"} (${dayText(job.checkout)})`).join(", ");

/** The confirmation's line about the cleaning schedule: the jobs they are on and have not marked, which they come off. */
async function jobsLine(cleaner: CleanerSummary): Promise<string | null> {
  if (cleaner.role === "handyman") return null;
  const result = await fetchUnmarkedJobs(cleaner.id);
  if (!result.ok) return "Their jobs could not be read: they still come off every job they have not marked.";
  const jobs = result.data.jobs;
  return jobs.length === 0 ? null : `They come off ${jobs.length === 1 ? "1 job" : `${jobs.length} jobs`} they have not marked: ${jobsWords(jobs)}. Jobs they marked keep their mark and cleaning.`;
}

/** What the answer says they came off, for the notice. */
const takenOffWords = (jobs: UnmarkedJob[]) => (jobs.length === 0 ? null : `Taken off ${jobs.length === 1 ? "1 job" : `${jobs.length} jobs`}: ${jobsWords(jobs)}.`);

/** "Oct 14, 19:45", Toronto. */
const clockWords = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));

export default function CleanersPage() {
  return (
    <Suspense fallback={null}>
      <PinGate>
        <Cleaners />
      </PinGate>
    </Suspense>
  );
}

function Cleaners() {
  const [list, setList] = useState<ListState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  /** The new-member dialog: open, what is typed in it, and a refusal to show in it. */
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<CleanerRole>("cleaner");
  /** The new member's code as typed in the dialog. */
  const [newCode, setNewCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<Notice | null>(null);
  const [patterns, setPatterns] = useState<PatternsState>({ kind: "loading" });
  /** The name of a create whose outcome is unknown. */
  const [unconfirmed, setUnconfirmed] = useState<string | null>(null);
  /** The one save in flight: a status, code change or delete, for one cleaner. */
  const [saving, setSaving] = useState<{ id: string; what: "status" | "code" | "delete" | "rate" } | null>(null);
  const [editor, setEditor] = useState<CodeEditor | null>(null);
  /** The cleaner whose default rate is being set (dispatch 37B), and what is typed. */
  const [rateEditor, setRateEditor] = useState<{ id: string; name: string; draft: string } | null>(null);
  const [codeDraft, setCodeDraft] = useState("");
  const codeInputRef = useRef<HTMLInputElement>(null);
  const { notice, show: showNotice, clear: clearNotice } = useNotice();
  /** Every question asked in Nubnb's own dialog (Kian's ruling of 2026-10-12: no native browser dialogs in the admin). */
  const { ask, dialog } = useAsk();
  /** The cleaner door's locks holding now (Kian's ruling of 2026-10-14, evening): an admin lifts them here. */
  const [locks, setLocks] = useState<{ kind: "loading" } | { kind: "ready"; locks: SignInLockView[] } | { kind: "error"; title: string }>({ kind: "loading" });
  const [lifting, setLifting] = useState<string | null>(null);
  const [payments, setPayments] = useState<PaymentsState>({ kind: "loading" });
  /** The person whose pay is open (?pay={id}), or null for the list. */
  const payId = useSearchParams().get("pay");

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

  // The 90-day distributions come from the cost entries: the same one read the costs page makes.
  useEffect(() => {
    let cancelled = false;
    fetchCosts().then((result) => {
      if (cancelled) return;
      setPatterns(
        result.ok
          ? { kind: "ready", patterns: watchList(result.data.entries, torontoDayOf(new Date())), entries: result.data.entries, cleanings: result.data.cleanings }
          : { kind: "error", title: result.title },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  useEffect(() => {
    let cancelled = false;
    fetchPayments().then((result) => {
      if (!cancelled) setPayments(result.ok ? { kind: "ready", payments: result.data.payments, unreadable: result.data.unreadable } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Each member's pay, by the one function (app/lib/pay/balance.ts), once the cost list and the payments are in. */
  const payOf = useMemo(() => {
    return (memberId: string): RowPay => {
      if (patterns.kind === "error") return { kind: "error", title: patterns.title };
      if (payments.kind === "error") return { kind: "error", title: payments.title };
      if (patterns.kind !== "ready" || payments.kind !== "ready") return { kind: "loading" };
      const entries = patterns.entries.filter((entry) => entry.kind !== "cleaning");
      return { kind: "ready", pay: memberPay(memberId, { cleanings: patterns.cleanings, entries, payments: payments.payments }), unreadable: payments.unreadable };
    };
  }, [patterns, payments]);

  useEffect(() => {
    let cancelled = false;
    fetchCleanerLocks().then((result) => {
      if (!cancelled) setLocks(result.ok ? { kind: "ready", locks: result.data.locks } : { kind: "error", title: result.title });
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  /** Open a person's pay, or go back to the list: the address changes, nothing is read again. */
  const openPay = (id: string) => {
    clearNotice();
    setEditor(null);
    setRateEditor(null);
    window.history.pushState(null, "", `/admin/cleaners?pay=${encodeURIComponent(id)}`);
    window.scrollTo(0, 0);
  };
  const closePay = () => {
    clearNotice();
    window.history.pushState(null, "", "/admin/cleaners");
  };
  const payHref = (id: string) => `/admin/cleaners?pay=${encodeURIComponent(id)}`;

  /** A payment as the server stored it, recorded or deleted, in place of the one held. */
  const putPayment = (payment: PaymentView) => {
    setPayments((prev) =>
      prev.kind === "ready"
        ? { ...prev, payments: prev.payments.some((p) => p.id === payment.id) ? prev.payments.map((p) => (p.id === payment.id ? payment : p)) : [payment, ...prev.payments] }
        : prev,
    );
  };

  const reload = () => {
    setList({ kind: "loading" });
    setPatterns({ kind: "loading" });
    setPayments({ kind: "loading" });
    setLocks({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  /** Lift a cleaner-door lock before its time: the connection's count goes with it. */
  const lift = async (lock: SignInLockView) => {
    if (lifting) return;
    setLifting(lock.id);
    const result = await liftCleanerLock(lock.id);
    setLifting(null);
    if (!result.ok && result.status !== 404) {
      showNotice(result.unknown ? { tone: "warning", title: "The lock may or may not have been lifted. Reload to see.", detail: result.title } : { tone: "error", title: result.title, detail: result.detail });
      return;
    }
    setLocks((prev) => (prev.kind === "ready" ? { kind: "ready", locks: prev.locks.filter((l) => l.id !== lock.id) } : prev));
    showNotice({ tone: "success", title: result.ok ? "Lifted. Sign-in from that connection works again." : "That lock had already ended." });
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
  const canCreate = name !== "" && CODE_PATTERN.test(newCode) && !creating;

  const openAdding = () => {
    clearNotice();
    setDraft("");
    setRole("cleaner");
    setNewCode("");
    setCreateError(null);
    setAdding(true);
  };

  const closeAdding = () => {
    setAdding(false);
    setDraft("");
    setNewCode("");
    setCreateError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canCreate) return;
    clearNotice();
    setCreateError(null);
    setUnconfirmed(null);
    setCreating(true);
    const result = await createCleaner(name, role, newCode);
    setCreating(false);

    if (result.ok) {
      const created = result.data.cleaner;
      closeAdding();
      showNotice({
        tone: "success",
        title: `Created ${displayName(created.name ?? name)} as a ${CLEANER_ROLE_LABELS[role].toLowerCase()}.`,
        detail: [created.code ? `Their code is ${created.code}.` : null, releasedWords(result.data.released)].filter(Boolean).join(" ") || undefined,
      });
      reload();
      return;
    }
    if (result.unknown) {
      closeAdding();
      setUnconfirmed(name);
      return;
    }
    // A refusal stays in the dialog, with what was typed.
    setCreateError({ tone: "error", title: result.title, detail: codeRefusalDetail(result, "Nothing was created.") });
  };

  const changeStatus = async (cleaner: CleanerSummary, target: CleanerStatus) => {
    if (busy) return;
    const who = displayName(cleaner.name);
    const jobs = target === "deactivated" ? await jobsLine(cleaner) : null;
    const yes =
      target === "deactivated"
        ? await ask({ title: `Deactivate ${who}?`, lines: ["Their code stops working at once and any signed-in phone is signed out. Their entries keep their name.", jobs], confirm: "Deactivate", danger: true })
        : await ask({ title: `Reactivate ${who}?`, lines: ["Their existing code works again. Phones signed in before are still signed out.", "They are put back on no job."], confirm: "Reactivate" });
    if (!yes) return;

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
        ? { tone: "success", title: `${target === "deactivated" ? "Deactivated" : "Reactivated"} ${who}.`, detail: takenOffWords(result.data.jobsTakenOff ?? []) ?? undefined }
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
    const yes =
      "code" in request
        ? await ask({ title: `Change ${target.name}'s code${target.current ? ` from ${target.current}` : ""} to ${request.code}?`, lines: [CODE_CHANGE_EFFECT], confirm: "Change code" })
        : await ask({ title: `Give ${target.name} a new code, chosen at random?`, lines: [`The old code${was} stops working at once. Any phone signed in with it is signed out.`], confirm: "Give a new code" });
    if (!yes) return;

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
          : { tone: "error", title: result.title, detail: codeRefusalDetail(result, "The code was not changed.") },
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
            detail: [target.current ? `${target.current} no longer works.` : null, releasedWords(result.data.released ?? null)].filter(Boolean).join(" ") || undefined,
          }
        : { tone: "info", title: `Nothing was changed: ${stored.code} is already ${target.name}'s code.` },
    );
  };

  /** Delete for good (Kian, 2026-10-02): the confirmation names what is lost; the row leaves only on the server's word. */
  const remove = async (cleaner: CleanerSummary) => {
    if (busy) return;
    const who = displayName(cleaner.name);
    // Kian's ruling of 2026-10-15: a member whose balance is not zero is never deleted. Said here without asking;
    // the server refuses it too.
    const rowPay = payOf(cleaner.id);
    if (rowPay.kind === "ready" && (rowPay.pay.balanceCents !== 0 || rowPay.pay.cannotAddUp > 0 || rowPay.unreadable > 0)) {
      showNotice({
        tone: "error",
        title: rowPay.pay.balanceCents !== 0 ? `${who}'s balance is ${balanceWords(rowPay.pay.balanceCents).words}, so they cannot be deleted.` : `${who}'s balance cannot be worked out, so they cannot be deleted.`,
        detail: "Deactivate them instead. Nothing was deleted.",
      });
      return;
    }
    const role = isCleanerRole(cleaner.role) ? CLEANER_ROLE_LABELS[cleaner.role] : cleaner.role;
    const all = patterns.kind === "ready" ? patterns.entries.filter((entry) => entry.cleaner.id === cleaner.id) : null;
    // Cleanings are logged by the office for them (dispatch 37B): counted apart from what they logged themselves.
    const theirs = all?.filter((entry) => entry.kind !== "cleaning") ?? null;
    const cleaned = all?.filter((entry) => entry.kind === "cleaning").length ?? 0;
    const pending = theirs?.filter((entry) => entry.status === "pending").length ?? 0;
    const entriesLine =
      theirs === null
        ? "Their entries could not be counted; any they logged stay on the ledger under their name."
        : theirs.length === 0
          ? "They logged no entries."
          : `They logged ${theirs.length === 1 ? "1 entry" : `${theirs.length} entries`}${pending > 0 ? ` (${pending} pending review)` : ""}; those stay on the ledger under the name “${cleaner.name ?? who}”.`;
    const cleaningsLine = cleaned === 0 ? null : `${cleaned === 1 ? "1 cleaning" : `${cleaned} cleanings`} done by them ${cleaned === 1 ? "stays" : "stay"}, under the same name.`;
    const jobs = await jobsLine(cleaner);
    const yes = await ask({
      title: `Delete ${who} for good?`,
      lines: [`${role}${cleaner.code ? `, code ${cleaner.code}` : ", no code on record"}. The code stops working at once; any signed-in phone is signed out.`, entriesLine, cleaningsLine, jobs, "The account cannot be reactivated. This cannot be undone."],
      confirm: "Delete for good",
      danger: true,
    });
    if (!yes) return;

    clearNotice();
    setSaving({ id: cleaner.id, what: "delete" });
    const result = await deleteCleaner(cleaner.id);
    setSaving(null);

    if (!result.ok) {
      showNotice(
        result.unknown
          ? { tone: "warning", title: "The team member may or may not have been deleted. Reload the list to see.", detail: result.title }
          : { tone: "error", title: result.title, detail: describeFailure(result, "Nothing was deleted.") },
      );
      return;
    }
    setList((prev) => (prev.kind === "ready" ? { kind: "ready", cleaners: prev.cleaners.filter((c) => c.id !== cleaner.id) } : prev));
    const offWords = takenOffWords(result.data.jobsTakenOff ?? []);
    showNotice({
      tone: "success",
      title: `Deleted ${who}.`,
      detail: `Their code no longer works.${theirs && theirs.length > 0 ? ` ${theirs.length === 1 ? "1 entry stays" : `${theirs.length} entries stay`} on the ledger under their name.` : ""}${offWords ? ` ${offWords}` : ""}`,
    });
  };

  /** Save a cleaner's default rate (dispatch 37B): the row changes only to what the server stored. */
  const saveRate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!rateEditor || busy) return;
    const typed = rateEditor.draft.trim();
    const match = /^\$?\s*(\d{1,4})(?:\.(\d{1,2}))?$/.exec(typed);
    if (typed !== "" && !match) {
      showNotice({ tone: "error", title: "Type the rate as dollars and cents, like 60.00, or leave it empty for none." });
      return;
    }
    const rate = match ? `${match[1]}.${(match[2] ?? "0").padEnd(2, "0")}` : null;
    if (rate === "0.00") {
      showNotice({ tone: "error", title: "A rate is more than $0.00. Leave it empty for none." });
      return;
    }
    clearNotice();
    setSaving({ id: rateEditor.id, what: "rate" });
    const result = await setDefaultRate(rateEditor.id, rate);
    setSaving(null);
    if (!result.ok) {
      showNotice(result.unknown ? { tone: "warning", title: "The rate may or may not have been saved. Reload the list to see.", detail: result.title } : { tone: "error", title: result.title, detail: describeFailure(result, "Nothing was saved.") });
      return;
    }
    replaceRow(result.data.cleaner);
    setRateEditor(null);
    showNotice({ tone: "success", title: result.data.changed ? `${rateEditor.name}'s default rate is ${rate === null ? "none" : `$${rate}`}.` : "Nothing was changed.", detail: "Cleanings already logged keep their amounts." });
  };

  const submitTypedCode = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (editor && CODE_PATTERN.test(codeDraft)) saveCode(editor, { code: codeDraft });
  };

  return (
    <div className={shared.container}>
      {/* ── Header ── the shared one; Refresh, and Add once the list has loaded */}
      <AdminHeader current="cleaners" />

      <main className={shared.main}>
        {/* ── The page's own buttons, in its head (Kian's ruling of 2026-10-15: none in the navigation). A person's pay
             has a head of its own, with Refresh in it. ── */}
        {payId === null && (
          <PageHead title="Team">
            <button type="button" className={shared.btnGhost} onClick={reload} disabled={list.kind === "loading"}>
              <RefreshCw size={15} aria-hidden />
              <span>Refresh</span>
            </button>
            {/* Never offered before the list has loaded: the person may already exist. */}
            {list.kind === "ready" && (
              <button type="button" className={shared.btnPrimary} onClick={openAdding}>
                <UserPlus size={16} aria-hidden />
                <span>Add team member</span>
              </button>
            )}
          </PageHead>
        )}

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

        {payId !== null ? (
          <PayBranch
            payId={payId}
            list={list}
            patterns={patterns}
            payments={payments}
            onBack={closePay}
            onRetry={reload}
            onPayment={putPayment}
            show={showNotice}
            clear={clearNotice}
            ask={ask}
          />
        ) : list.kind === "loading" ? (
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

            {rateEditor && (
              <form className={styles.codeEditor} onSubmit={saveRate} aria-labelledby="rate-editor-title">
                <h2 id="rate-editor-title" className={styles.codeEditorTitle}>
                  <span>Default cleaning rate for {rateEditor.name}</span>
                </h2>
                <p className={styles.codeEditorNote}>A cleaning&apos;s amount starts from what they were last paid for the property, or this rate if none. Cleanings already logged keep their amounts.</p>
                <div className={styles.codeEditorRow}>
                  <label htmlFor="cleaner-rate" className={styles.createLabel}>
                    Rate ($)
                  </label>
                  <input id="cleaner-rate" type="text" inputMode="decimal" autoComplete="off" placeholder="60.00" className={styles.codeInput} value={rateEditor.draft} onChange={(e) => setRateEditor({ ...rateEditor, draft: e.target.value })} disabled={busy} autoFocus />
                  <button type="submit" className={`${shared.btnPrimary} ${styles.createBtn}`} disabled={busy}>
                    {saving?.what === "rate" ? "Saving…" : "Save rate"}
                  </button>
                  <button type="button" className={styles.btnGhost} onClick={() => setRateEditor(null)} disabled={busy}>
                    Cancel
                  </button>
                </div>
              </form>
            )}

            {/* ── List ── */}
            {list.cleaners.length === 0 ? (
              <div className={shared.empty}>
                <Users size={48} strokeWidth={1} />
                <h2>No team members yet</h2>
                <button type="button" className={shared.btnPrimary} onClick={openAdding}>
                  <UserPlus size={16} aria-hidden />
                  <span>Add team member</span>
                </button>
              </div>
            ) : (
              <div className={`${shared.tableContainer} ${styles.tableScroll}`}>
                <table className={shared.table}>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Role</th>
                      <th>Code</th>
                      <th>Status</th>
                      <th>Rate</th>
                      <th>Last 90 days</th>
                      <th className={styles.payHead}>Earned</th>
                      <th className={styles.payHead}>Paid</th>
                      <th className={styles.payHead}>Balance</th>
                      <th className={shared.actionsHeader}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.cleaners.map((cleaner) => {
                      const next = nextStatus(cleaner.status);
                      return (
                        <tr key={cleaner.id}>
                          <td className={styles.nameCell}>
                            <a
                              href={payHref(cleaner.id)}
                              className={styles.nameLink}
                              onClick={(event) => {
                                if (!plainClick(event)) return;
                                event.preventDefault();
                                openPay(cleaner.id);
                              }}
                            >
                              <FieldText value={cleaner.name} />
                            </a>
                          </td>
                          <td>
                            <RoleBadge role={cleaner.role} />
                          </td>
                          <td>
                            <CodeCell code={cleaner.code} />
                          </td>
                          <td>
                            <StatusBadge status={cleaner.status} />
                          </td>
                          <td className={styles.rateCell}>
                            {cleaner.role !== "cleaner" ? <span className={styles.muted}>—</span> : cleaner.defaultRateCents === null ? <span className={styles.muted}>None</span> : `$${(cleaner.defaultRateCents / 100).toFixed(2)}`}
                          </td>
                          <td className={styles.patternCell}>
                            <Pattern cleaner={cleaner} state={patterns} />
                          </td>
                          <PayCells pay={payOf(cleaner.id)} />
                          <td className={styles.actionCell}>
                            <div className={styles.actionRow}>
                              {saving?.id === cleaner.id && <span className={styles.muted}>{saving.what === "delete" ? "Deleting…" : "Saving…"}</span>}
                              <a
                                href={payHref(cleaner.id)}
                                className={`${styles.rowAction} ${styles.rowActionLink}`}
                                onClick={(event) => {
                                  if (!plainClick(event)) return;
                                  event.preventDefault();
                                  openPay(cleaner.id);
                                }}
                              >
                                Pay
                              </a>
                              {/* The rest behind "⋯" (TEAM-PAY-PLAN.md §4); no status action for a status that is neither: nothing to flip it to. */}
                              <RowMenu
                                label={`More for ${displayName(cleaner.name)}`}
                                disabled={busy}
                                items={[
                                  { label: cleaner.code === null ? "Set code" : "Change code", onSelect: () => openEditor(cleaner) },
                                  ...(cleaner.role === "cleaner" ? [{ label: "Set rate", onSelect: () => setRateEditor({ id: cleaner.id, name: displayName(cleaner.name), draft: cleaner.defaultRateCents === null ? "" : (cleaner.defaultRateCents / 100).toFixed(2) }) }] : []),
                                  ...(next ? [{ label: next === "deactivated" ? "Deactivate" : "Reactivate", onSelect: () => changeStatus(cleaner, next) }] : []),
                                  { label: "Delete…", danger: true, onSelect: () => remove(cleaner) },
                                ]}
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            {/* ── The cleaner door's locks (Kian's ruling of 2026-10-14, evening): shown only while one holds ── */}
            {locks.kind === "error" && <NoticeBanner className={shared.pageNotice} notice={{ tone: "warning", title: "The cleaner sign-in locks could not be read.", detail: locks.title }} />}
            {locks.kind === "ready" && locks.locks.length > 0 && (
              <section className={styles.locks} aria-label="Cleaner sign-in locks">
                <h2 className={styles.locksTitle}>Cleaner sign-in locks · {locks.locks.length}</h2>
                <ul className={styles.locksList}>
                  {locks.locks.map((lock) => (
                    <li key={lock.id} className={styles.lockRow}>
                      <span>
                        {lock.capped ? "20 wrong codes today · until lifted" : `5 wrong codes in a row · until ${lock.lockedUntil ? clockWords(lock.lockedUntil) : "?"}`}
                        <span className={styles.lockMeta}> · one connection{lock.lastFailedAt ? `, last wrong code ${clockWords(lock.lastFailedAt)}` : ""}</span>
                      </span>
                      <button type="button" className={shared.btnGhost} onClick={() => lift(lock)} disabled={lifting !== null}>
                        {lifting === lock.id ? "Lifting…" : "Lift"}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}
      </main>

      {adding && (
        <NewMemberDialog
          name={draft}
          role={role}
          creating={creating}
          error={createError}
          code={newCode}
          onName={setDraft}
          onRole={setRole}
          onCode={setNewCode}
          onGenerate={() => setNewCode(suggestCode())}
          onSubmit={submit}
          onClose={closeAdding}
        />
      )}
      {dialog}
    </div>
  );
}

/** A person's pay (?pay={id}), once the team, the cost list and the payments are in; a failed read is said, never shown as nothing. */
function PayBranch({ payId, list, patterns, payments, onBack, onRetry, onPayment, show, clear, ask }: { payId: string; list: ListState; patterns: PatternsState; payments: PaymentsState; onBack: () => void; onRetry: () => void; onPayment: (payment: PaymentView) => void } & Pick<Parameters<typeof PayView>[0], "show" | "clear" | "ask">) {
  const failed = list.kind === "error" ? list.title : patterns.kind === "error" ? patterns.title : payments.kind === "error" ? payments.title : null;
  if (failed !== null) {
    return (
      <div className={`${shared.empty} ${shared.loadError}`} role="alert">
        <AlertTriangle size={48} strokeWidth={1} />
        <h2>Their pay could not be worked out</h2>
        <p>Something it is worked out from has not loaded. Nothing is shown rather than a balance that might be wrong.</p>
        <code className={shared.loadErrorDetail}>{failed}</code>
        <button type="button" className={shared.btnPrimary} onClick={onRetry}>
          <RefreshCw size={18} />
          <span>Retry</span>
        </button>
      </div>
    );
  }
  if (list.kind !== "ready" || patterns.kind !== "ready" || payments.kind !== "ready") {
    return (
      <div className={shared.loading}>
        <div className={shared.spinner} />
        <p>Loading their pay…</p>
      </div>
    );
  }
  const member = list.cleaners.find((cleaner) => cleaner.id === payId);
  if (!member) {
    return (
      <div className={shared.empty}>
        <Users size={48} strokeWidth={1} />
        <h2>No team member with this ID</h2>
        <p>They may have been deleted.</p>
        <button type="button" className={shared.btnPrimary} onClick={onBack}>
          <span>Back to Team</span>
        </button>
      </div>
    );
  }
  return (
    <PayView
      key={member.id}
      member={member}
      cleanings={patterns.cleanings}
      entries={patterns.entries}
      payments={payments.payments}
      unreadablePayments={payments.unreadable}
      today={torontoDayOf(new Date())}
      onBack={onBack}
      onRefresh={onRetry}
      onPayment={onPayment}
      show={show}
      clear={clear}
      ask={ask}
    />
  );
}

/** Earned, Paid and Balance (Team pay, Kian's ruling 5 of 2026-10-15): worked out, loading, or said to be unreadable. */
function PayCells({ pay }: { pay: RowPay }) {
  if (pay.kind !== "ready") {
    const text = pay.kind === "loading" ? "…" : "Could not be read";
    return (
      <>
        <td className={styles.payCell} title={pay.kind === "error" ? pay.title : undefined}>
          <span className={pay.kind === "error" ? styles.patternWarn : styles.muted}>{text}</span>
        </td>
        <td className={styles.payCell} />
        <td className={styles.payCell} />
      </>
    );
  }
  const balance = balanceWords(pay.pay.balanceCents);
  const uncertain = pay.pay.cannotAddUp + pay.unreadable;
  return (
    <>
      <td className={styles.payCell}>{formatCents(pay.pay.earnedCents)}</td>
      <td className={styles.payCell}>{formatCents(pay.pay.paidCents)}</td>
      <td className={`${styles.payCell} ${balance.tone === "overpaid" || uncertain > 0 ? styles.payWarn : ""}`}>
        {balance.tone === "settled" ? <span className={styles.muted}>—</span> : balance.words}
        {uncertain > 0 && <span className={styles.payNote}> · {uncertain === 1 ? "1 record" : `${uncertain} records`} left out</span>}
      </td>
    </>
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

/** A stored role (dispatch 24). One outside the two is shown as stored, marked as unexpected. */
function RoleBadge({ role }: { role: string }) {
  if (isCleanerRole(role)) {
    return <span className={`${styles.badge} ${role === "handyman" ? styles.badgeHandyman : styles.badgeCleaner}`}>{CLEANER_ROLE_LABELS[role]}</span>;
  }
  return (
    <span className={`${styles.badge} ${styles.badgeOdd}`} title="Not one of cleaner or handyman">
      {role.trim() === "" ? "Empty" : role}
    </span>
  );
}

/** A cleaner's last 90 days in words; a handyman has no receipts to count; a failed read is said, never shown as nothing. */
function Pattern({ cleaner, state }: { cleaner: CleanerSummary; state: PatternsState }) {
  if (cleaner.role === "handyman") return <span className={styles.patternMuted}>Logs work, not receipts</span>;
  if (state.kind === "loading") return <span className={styles.patternMuted}>…</span>;
  if (state.kind === "error") {
    return (
      <span className={styles.patternWarn} title={state.title}>
        Could not be read
      </span>
    );
  }
  const pattern = state.patterns.find((p) => p.cleanerId === cleaner.id);
  if (!pattern) return <span className={styles.patternMuted}>No receipts in the last 90 days</span>;
  return (
    <span className={pattern.worthALook ? styles.patternWarn : undefined}>
      {distributionText(pattern)}
      {pattern.worthALook && ` · Worth a look: ${pattern.reasons.join("; ")}`}
    </span>
  );
}

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

/** The deactivated account that held the code just given out: said once, in the notice. */
function releasedWords(released: { id: string; name: string | null } | null): string | null {
  if (!released) return null;
  return `It was ${displayName(released.name)}'s (deactivated); they now have no code.`;
}

/** A name to put in a sentence. */
function displayName(name: string | null): string {
  return name !== null && name.trim() !== "" ? name : "this cleaner";
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/**
 * A typed code refused for a reason its one line says (Kian's ruling of 2026-10-17: every refusal says why in one
 * plain line): an admin's PIN, an active account's code, no code free to draw, or a locked connection.
 */
const ONE_LINE_REFUSALS: ReadonlySet<string> = new Set(['CLEANER_CODE_IS_ADMIN_PIN', 'CLEANER_CODE_TAKEN', 'CLEANER_CODE_UNAVAILABLE', 'ADMIN_SIGN_IN_LOCKED']);

/** A code refusal's detail: none for one whose line says why, else describeFailure's. */
function codeRefusalDetail(failure: CleanerFailure, nothingDone: string): string | undefined {
  return failure.code !== undefined && ONE_LINE_REFUSALS.has(failure.code) ? undefined : describeFailure(failure, nothingDone);
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
