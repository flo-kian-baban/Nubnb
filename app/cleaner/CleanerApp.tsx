"use client";

/**
 * The cleaner app: one page, one screen at a time (Kian's rulings of
 * 2026-10-16, in CLAUDE.md under *Cleaner app*).
 *
 *   code → home → camera → receipt → sent
 *
 * Home: the cleaner's jobs for today and tomorrow, with Mark cleaned, each
 * card with its unit's photo and badges; under them every unit, "All units",
 * where a tap starts a receipt for that unit (Kian's rulings of 2026-10-17);
 * then one "Add a receipt" button (HomeScreen, JobsSection, UnitList).
 * Adding a receipt starts with the camera (CameraScreen). The photo is read
 * while the cleaner goes on to the one receipt screen: the property, the
 * items and the tax, editable, with Send (ReceiptScreen). The property starts
 * on the job marked cleaned that day, else the soonest job today, else none
 * (receiptProperty, app/lib/cleaner-home.ts); it is shown in bold above Send,
 * with Change, which opens the property list, recent ones first
 * (PropertyScreen). A cleaned job reads "Cleaned · Undo", with "Add a receipt
 * for this unit", which starts the receipt on that job's property. History
 * (HistoryScreen), on the home screen's bar, lists the jobs done and the
 * receipts sent. No pay anywhere: none is sent to the app.
 *
 * There is no sign-out (Kian, 2026-09-30): a session ends by itself after
 * 12 hours, and a new code ends it at once.
 *
 * ── State ──
 * Before a cleaner is in, the app is loading, on the code screen, or unable
 * to reach the server. Once in, the receipt being worked on is the draft
 * (cleaner-draft.ts), written to the phone on every change and cleared only
 * when the server confirms it. Where the cleaner is — home, or the receipt —
 * is part of the draft, so a reopened page lands where the cleaner left off,
 * after the code if their session ended. A receipt begun and not sent stays
 * on the phone when the cleaner goes home; the home button then finishes it
 * rather than starting another. The camera, the property list and History
 * are views over the screen beneath; they are never kept.
 *
 * ── Back ──
 * Each screen opened adds a history entry, so the phone's Back goes to the
 * screen before rather than out of the app: the camera, the property list
 * and History close; the receipt goes home. The photo taken from home turns
 * the camera's entry into the receipt's, so Back from the receipt is home.
 * The receipt shows only when it has a photo.
 *
 * ── Sending ──
 * A send carries the draft's one-time key. Whatever happens to the answer —
 * no signal, a timeout, a server failure — sending again is safe: a receipt
 * that already arrived is reported as sent and nothing is written twice. A
 * receipt changed after a send whose outcome is unknown gets a new key.
 *
 * ── Reading the receipt (dispatches 20 and 21) ──
 * As soon as the photo is kept, it goes to the server to be read, and the
 * cleaner moves on to the receipt screen, whose items and tax stay locked
 * until the answer comes; the property can be checked and changed meanwhile.
 * Then the lines it read are the form's lines, marked "From the photo", and
 * the receipt's tax is in the tax field. No answer, or a failed one, unlocks
 * the form for typing with a quiet note; the photo is kept either way. The
 * signed answer stays in the draft and goes with the entry as evidence. The
 * purchase date is never filled from it (Kian's ruling of 2026-09-30).
 *
 * A cleaner never reaches /admin from here, and never sees another cleaner's
 * work: the API gives this page their own name, jobs and recent properties,
 * the property list, and item names as words only.
 *
 * ── Handymen (dispatch 24) ──
 * The start route says the account's role. A handyman gets the work flow
 * (HandymanApp): home → work → sent, and History. The code screen and the
 * loading and failure states are shared.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloudOff } from "lucide-react";
import {
  jobAction,
  loadStart,
  readReceipt,
  sendEntry,
  signIn,
  type SignInResult,
  type StartResult,
} from "@/app/lib/cleaner-client";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import {
  STEPS,
  clearDraft,
  clearPhoto,
  forgetReading,
  isEmptyDraft,
  loadDraft,
  loadPhoto,
  newDraft,
  newLine,
  newSubmissionKey,
  recordOf,
  saveDraft,
  savePhoto,
  takeReading,
  toEntryPayload,
  toReadingPart,
  totalCents,
  type Draft,
  type DraftLine,
  type Step,
  type StoredPhoto,
} from "@/app/lib/cleaner-draft";
import { homeJobs, receiptProperty, type ReceiptProperty } from "@/app/lib/cleaner-home";
import { PhotoError, preparePhoto, type PhotoProblem, type PreparedPhoto } from "@/app/lib/receipt-photo";
import { leftOutOfReading, type CleanerProperty, type CleanerStart } from "@/app/lib/cleaners/model";
import { fold } from "@/app/lib/cleaners/text";
import { CodeScreen } from "./CodeScreen";
import { HomeScreen } from "./HomeScreen";
import { PropertyScreen } from "./PropertyScreen";
import { CameraScreen } from "./CameraScreen";
import { ReceiptScreen, type ReadingStatus } from "./ReceiptScreen";
import { DoneScreen, type SentReceipt } from "./DoneScreen";
import { HistoryScreen } from "./HistoryScreen";
import { CleanerBar } from "./CleanerBar";
import { HandymanApp } from "./HandymanApp";
import { JobsSection } from "./JobsSection";
import styles from "./cleaner.module.css";

type Phase =
  | { kind: "loading" }
  | { kind: "code" }
  | { kind: "offline" }
  | { kind: "failed" }
  | { kind: "in"; start: CleanerStart };

/** A screen over the step: the camera, the property list, History. */
type View = "camera" | "picker" | "history";

const VIEWS: readonly View[] = ["camera", "picker", "history"];

/** The photo just taken or chosen, while it is prepared, and why it could not be used. */
type PhotoState = { kind: "idle" } | { kind: "preparing" } | { kind: "error"; problem: PhotoProblem };

/** The draft's photo, with an object URL to show it by. */
interface PhotoInHand extends StoredPhoto {
  url: string;
}

const OFFLINE = "No signal. Your receipt is saved on this phone. Send it when you have signal.";
const NOT_CONFIRMED = "Not confirmed. Tap Send again — it won’t be counted twice.";
const PROPERTY_GONE = "That property is no longer on the list. Choose it again.";
const PHOTO_REFUSED = "That photo couldn’t be used. Take it again.";
const REFUSED = "This receipt couldn’t be saved. Check each item and send again.";
const UNSENT = "This receipt is not sent yet. Send it first, then add the next.";

const PHOTO_PROBLEMS: Record<PhotoProblem, string> = {
  unreadable: "This photo can’t be used. Take a new one.",
  "too-large": "This photo is too big. Take a new one with the camera.",
};

/** Refusals that mean the photo itself must be taken again. */
const PHOTO_CODES = new Set([
  "RECEIPT_MISSING",
  "RECEIPT_TYPE_REJECTED",
  "RECEIPT_TOO_LARGE",
  "RECEIPT_EMPTY",
  "RECEIPT_NOT_AN_IMAGE",
  "ENTRY_REQUEST_TOO_LARGE",
]);

function isStep(value: unknown): value is Step {
  return STEPS.includes(value as Step);
}

function isView(value: unknown): value is View {
  return VIEWS.includes(value as View);
}

/** The receipt shows only once it has a photo; home otherwise. */
function reachable(step: Step, draft: Draft): Step {
  return step === "receipt" && draft.photoKey !== null ? "receipt" : "home";
}

/** What the receipt screen says about the reading of the current photo. */
function readingStatus(draft: Draft, readingPhotoKey: string | null): ReadingStatus {
  if (draft.photoKey === null) return { kind: "none" };
  if (readingPhotoKey === draft.photoKey) return { kind: "reading" };
  const { reading } = draft;
  if (!reading || reading.photoKey !== draft.photoKey) return { kind: "none" };
  const record = recordOf(reading);
  if (record?.status === "ok" && reading.applied > 0) {
    return { kind: "read", applied: reading.applied, leftOut: leftOutOfReading(record.output) };
  }
  return { kind: "failed" };
}

function subscribeToConnection(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

/** The first line with something missing, into view and focused. */
function showFirstProblem() {
  const card = document.querySelector<HTMLElement>('[data-problem="true"]');
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  // A field marked invalid; at the property, its Choose button.
  (card?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? card?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
}

export function CleanerApp() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [draft, setDraftState] = useState<Draft | null>(null);
  const [photo, setPhoto] = useState<PhotoInHand | null>(null);
  /** False when the phone refused to keep the draft or its photo. */
  const [kept, setKept] = useState(true);
  const [sent, setSent] = useState<SentReceipt | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** The camera, the property list or History, open over the step; null when none is. */
  const [view, setView] = useState<View | null>(null);
  const [photoState, setPhotoState] = useState<PhotoState>({ kind: "idle" });
  /** The photo whose reading is in flight, for the screen; null when none is. */
  const [readingPhotoKey, setReadingPhotoKey] = useState<string | null>(null);
  /** The cleaner's jobs as they stand after a mark or an undo (the cleaning schedule); the start's until then. */
  const [jobs, setJobs] = useState<CleanerJobView[] | null>(null);
  const [jobBusy, setJobBusy] = useState<string | null>(null);
  const [jobMessages, setJobMessages] = useState<Record<string, string>>({});
  const online = useSyncExternalStore(subscribeToConnection, () => navigator.onLine, () => true);

  // The latest draft and cleaner for handlers that run between renders:
  // Back, and the steps of a send. Written only by the handlers below.
  const draftRef = useRef<Draft | null>(null);
  const cleanerIdRef = useRef<string | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  /** History entries this page has added and not yet gone back over. */
  const stepsPushedRef = useRef(0);
  /** The photo whose reading is in flight, for the handlers. An answer for any other photo is dropped. */
  const readingRef = useRef<string | null>(null);
  /** The step the camera opened over: from home a photo turns its entry into the receipt's; from the receipt, Back. */
  const cameraOverRef = useRef<Step>("home");
  /** The property the receipt being started is for, taken when its photo is: `explicit` for "this unit", over any kept. */
  const startingRef = useRef<{ property: ReceiptProperty | null; explicit: boolean } | null>(null);

  /** The draft as it now is: shown, and written to the phone. */
  const commit = useCallback((next: Draft) => {
    draftRef.current = next;
    setDraftState(next);
    const id = cleanerIdRef.current;
    if (!id) return;
    if (isEmptyDraft(next)) {
      clearDraft(id);
      return;
    }
    const saved = saveDraft(id, next);
    setKept((was) => (saved ? was : false));
  }, []);

  /** Show this photo, letting go of the last one's object URL. */
  const replacePhoto = useCallback((next: StoredPhoto | null) => {
    if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    const url = next ? URL.createObjectURL(next.blob) : null;
    photoUrlRef.current = url;
    setPhoto(next && url ? { ...next, url } : null);
  }, []);

  /**
   * Send the photo to be read, once per photo, and take the answer into the
   * draft when it comes — unless the photo has changed meanwhile, in which
   * case the answer is dropped. Nothing here waits: the cleaner moves on.
   */
  const startReading = useCallback(
    async (photoKey: string, blob: Blob, name: string) => {
      if (readingRef.current === photoKey) return;
      readingRef.current = photoKey;
      setReadingPhotoKey(photoKey);
      const result = await readReceipt(blob, name);
      if (readingRef.current !== photoKey) return;
      readingRef.current = null;
      setReadingPhotoKey(null);

      const current = draftRef.current;
      if (!current || current.photoKey !== photoKey || !cleanerIdRef.current) return;
      // The session ended: nothing is recorded, and the reading is asked for again after the code.
      if (result.kind === "signed-out") return;
      const next =
        result.kind === "ok"
          ? takeReading(current, photoKey, result.readingText, result.signature)
          : takeReading(current, photoKey, null, null);
      // Lines arriving is a change to the receipt: after an unanswered send, a new key.
      commit(current.unconfirmedSend ? { ...next, submissionKey: newSubmissionKey(), unconfirmedSend: false } : next);
    },
    [commit],
  );

  /** Act on what GET /api/cleaner/start said: the code screen, a failure, or in, with the draft restored. */
  const enter = useCallback(
    async (result: StartResult) => {
      if (result.kind !== "ok") {
        setPhase({ kind: result.kind === "signed-out" ? "code" : result.kind });
        return;
      }
      const { start } = result;
      const id = start.cleaner.id;
      const stored = loadDraft(id) ?? newDraft();
      const storedPhoto = await loadPhoto(id, stored.photoKey);
      // A photo the draft names but the phone no longer holds: take it again.
      const restored = storedPhoto ? stored : { ...stored, photoKey: null };
      const step = reachable(restored.step, restored);

      cleanerIdRef.current = id;
      setKept(true);
      replacePhoto(storedPhoto);
      commit({ ...restored, step });
      setSent(null);
      setSending(null);
      setSendMessage(null);
      setNotice(null);
      setShowProblems(false);
      setView(null);
      setPhotoState({ kind: "idle" });
      startingRef.current = null;
      window.history.replaceState({ cleanerStep: step }, "");
      setJobs(start.jobs);
      setJobMessages({});
      setPhase({ kind: "in", start });
      // A photo kept with no reading yet — the page closed while it was being read — is read now.
      if (storedPhoto && restored.photoKey && restored.reading?.photoKey !== restored.photoKey) {
        void startReading(restored.photoKey, storedPhoto.blob, storedPhoto.name);
      }
    },
    [commit, replacePhoto, startReading],
  );

  // Open: who is signed in, and what they were doing.
  useEffect(() => {
    let cancelled = false;
    loadStart().then((result) => {
      if (!cancelled) void enter(result);
    });
    return () => {
      cancelled = true;
    };
  }, [enter]);

  // The phone's Back: the screen before, as far as the draft allows.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      stepsPushedRef.current = Math.max(0, stepsPushedRef.current - 1);
      const requestedView: unknown = event.state?.cleanerView;
      setView(isView(requestedView) ? requestedView : null);
      setPhotoState({ kind: "idle" });
      const current = draftRef.current;
      if (!current || !cleanerIdRef.current) return;
      const requested: unknown = event.state?.cleanerStep;
      setSent(null);
      setNotice(null);
      commit({ ...current, step: reachable(isStep(requested) ? requested : "home", current) });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [commit]);

  // Let go of the photo's object URL when the page goes.
  useEffect(
    () => () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    },
    [],
  );

  const retry = async () => {
    setPhase({ kind: "loading" });
    await enter(await loadStart());
  };

  /**
   * Mark a job cleaned, or undo one's own mark (the cleaning schedule). Sending again after a lost answer is safe: a
   * mark is never made twice. The job then reads as the server answered.
   */
  const actOnJob = async (job: CleanerJobView, action: "mark" | "undo") => {
    if (jobBusy) return;
    setJobBusy(job.id);
    setJobMessages((prev) => ({ ...prev, [job.id]: "" }));
    const result = await jobAction(job.id, action);
    setJobBusy(null);
    if (result.kind === "signed-out") {
      setPhase({ kind: "code" });
      return;
    }
    if (result.kind === "ok") {
      if (result.job) {
        const next = result.job;
        setJobs((prev) => (prev ?? []).map((j) => (j.id === next.id ? next : j)));
      } else {
        await retry();
      }
      return;
    }
    const message =
      result.kind === "refused"
        ? result.message
        : result.offline
          ? "No signal. Nothing was recorded. Try again when you have signal."
          : action === "mark"
            ? "Not confirmed. Tap Mark cleaned again — it won’t be counted twice."
            : "Not confirmed. Tap Undo again.";
    setJobMessages((prev) => ({ ...prev, [job.id]: message }));
  };

  const submitCode = async (code: string): Promise<SignInResult> => {
    const result = await signIn(code);
    if (result.kind !== "ok") return result;
    const start = await loadStart();
    // Signed in, yet not: the phone did not keep the session cookie.
    if (start.kind === "signed-out") return { kind: "failed" };
    await enter(start);
    return { kind: "ok" };
  };

  /** Open the camera, the property list or History over the step, as a new history entry, so Back closes it. */
  const openView = (next: View) => {
    const step = draftRef.current?.step ?? "home";
    if (next === "camera") cameraOverRef.current = step;
    setView(next);
    window.history.pushState({ cleanerStep: step, cleanerView: next }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  /** Close the view: the phone's Back when this page added its entry, else closed in place. */
  const closeView = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setView(null);
    setPhotoState({ kind: "idle" });
    window.history.replaceState({ cleanerStep: draftRef.current?.step ?? "home" }, "");
    window.scrollTo(0, 0);
  };

  /** The session ended while History was open: the code, then back to where the cleaner was. */
  const historySignedOut = useCallback(() => {
    setView(null);
    setPhase({ kind: "code" });
  }, []);

  /** Move to a step, as a new history entry. */
  const goTo = (step: Step) => {
    const current = draftRef.current;
    if (!current) return;
    setNotice(null);
    commit({ ...current, step: reachable(step, current) });
    window.history.pushState({ cleanerStep: step }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  /**
   * The receipt's own Back: home. Over an entry this page added, it is the
   * phone's Back; on a page reopened mid-receipt there is none behind, so
   * home is shown in place instead of leaving the app. The receipt stays on
   * the phone.
   */
  const stepBack = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    setNotice(null);
    commit({ ...current, step: "home" });
    window.history.replaceState({ cleanerStep: "home" }, "");
    window.scrollTo(0, 0);
  };

  /** Any change to the receipt itself. After a send with no answer, it is a new receipt: a new key. */
  const changeReceipt = (change: (draft: Draft) => Draft) => {
    const current = draftRef.current;
    if (!current) return;
    let next = change(current);
    if (current.unconfirmedSend) next = { ...next, submissionKey: newSubmissionKey(), unconfirmedSend: false };
    setSendMessage(null);
    commit(next);
  };

  /**
   * Add a receipt: the camera, at once (ruling 4), with the property it will be for — the day's job (ruling 5), or
   * the unit the cleaner pressed it on. A receipt begun and not sent is opened instead, so nothing on it is lost.
   */
  const startReceipt = (property: ReceiptProperty | null, explicit: boolean) => {
    const current = draftRef.current;
    if (!current) return;
    if (current.photoKey !== null) {
      goTo("receipt");
      // Pressed on a unit: an unsent receipt with no property yet takes it; one for another unit is said to wait.
      if (explicit && property && current.propertyId === null) changeReceipt((d) => ({ ...d, propertyId: property.id, propertyName: property.name }));
      else if (explicit && property?.id !== current.propertyId) setNotice(UNSENT);
      return;
    }
    startingRef.current = { property, explicit };
    setNotice(null);
    setPhotoState({ kind: "idle" });
    openView("camera");
  };

  const acceptPhoto = async (prepared: PreparedPhoto) => {
    const id = cleanerIdRef.current;
    if (!id) return;
    const stored: StoredPhoto = {
      photoKey: newSubmissionKey(),
      blob: prepared.blob,
      name: prepared.name,
      width: prepared.width,
      height: prepared.height,
    };
    replacePhoto(stored);
    const starting = startingRef.current;
    startingRef.current = null;
    // A new photo: the last reading and the untouched lines it filled go; typed and changed lines stay. A receipt
    // being started takes its property now: the unit pressed on, or the day's job when it has none yet.
    changeReceipt((d) => {
      const next: Draft = { ...forgetReading(d), photoKey: stored.photoKey, step: "receipt" };
      const property = starting?.property;
      return property && (starting.explicit || next.propertyId === null) ? { ...next, propertyId: property.id, propertyName: property.name } : next;
    });
    readingRef.current = null;
    setReadingPhotoKey(null);
    void startReading(stored.photoKey, stored.blob, stored.name);
    const saved = await savePhoto(id, stored);
    setKept((was) => (saved ? was : false));
  };

  /** A photo from the camera or the phone: prepared, kept, read, and the receipt shown while it is read. */
  const takePhoto = async (file: File) => {
    setPhotoState({ kind: "preparing" });
    let prepared: PreparedPhoto;
    try {
      prepared = await preparePhoto(file);
    } catch (err) {
      setPhotoState({ kind: "error", problem: err instanceof PhotoError ? err.problem : "unreadable" });
      return;
    }
    await acceptPhoto(prepared);
    setPhotoState({ kind: "idle" });
    setNotice(null);
    setView(null);
    window.scrollTo(0, 0);
    if (cameraOverRef.current === "receipt") {
      // Retaken: back over the camera's entry to the receipt's.
      window.history.back();
    } else {
      // From home: the camera's entry becomes the receipt's, so Back from the receipt is home.
      window.history.replaceState({ cleanerStep: "receipt" }, "");
    }
  };

  const chooseProperty = (property: CleanerProperty) => {
    if (draftRef.current?.propertyId !== property.id) {
      changeReceipt((d) => ({ ...d, propertyId: property.id, propertyName: property.name }));
    }
    setNotice(null);
    closeView();
  };

  const changeLine = (key: string, change: Partial<Omit<DraftLine, "key">>) => {
    changeReceipt((d) => ({ ...d, lines: d.lines.map((line) => (line.key === key ? { ...line, ...change } : line)) }));
  };

  const changeTax = (tax: string) => {
    changeReceipt((d) => ({ ...d, tax }));
  };

  const addLine = () => {
    const line = newLine();
    changeReceipt((d) => ({ ...d, lines: [...d.lines, line] }));
    requestAnimationFrame(() => {
      const field = document.getElementById(`line-${line.key}-name`);
      field?.scrollIntoView({ behavior: "smooth", block: "center" });
      field?.focus({ preventScroll: true });
    });
  };

  const removeLine = (key: string) => {
    const line = draftRef.current?.lines.find((l) => l.key === key);
    const typed = line && (line.name.trim() !== "" || line.price.trim() !== "");
    if (typed && !window.confirm("Remove this item?")) return;
    changeReceipt((d) => ({ ...d, lines: d.lines.filter((l) => l.key !== key) }));
  };

  const startOver = () => {
    if (!window.confirm("Clear this receipt? What you typed and the photo will be removed.")) return;
    const id = cleanerIdRef.current;
    replacePhoto(null);
    if (id) void clearPhoto(id);
    readingRef.current = null;
    setReadingPhotoKey(null);
    setShowProblems(false);
    setSendMessage(null);
    setNotice(null);
    commit(newDraft());
    window.history.replaceState({ cleanerStep: "home" }, "");
    window.scrollTo(0, 0);
  };

  const send = async (propertyName: string) => {
    const current = draftRef.current;
    const id = cleanerIdRef.current;
    if (!current || !id || sending !== null) return;

    const payload = toEntryPayload(current);
    if (!payload) {
      setShowProblems(true);
      requestAnimationFrame(showFirstProblem);
      return;
    }
    if (!photo) {
      openView("camera");
      return;
    }
    if (!navigator.onLine) {
      setSendMessage(OFFLINE);
      return;
    }

    setShowProblems(false);
    setSendMessage(null);
    setSending(0);
    // Marked before the request leaves: should the page die mid-send, the
    // next change to the receipt still gets a new key.
    const attempt: Draft = { ...current, unconfirmedSend: true };
    commit(attempt);

    const result = await sendEntry(payload, photo.blob, photo.name, toReadingPart(current), (done) => setSending(done));
    setSending(null);

    switch (result.kind) {
      case "sent": {
        clearDraft(id);
        void clearPhoto(id);
        // An answer still on its way is for a receipt that is gone.
        readingRef.current = null;
        setReadingPhotoKey(null);
        setSent({
          propertyName,
          lineCount: payload.lines.length,
          totalCents: totalCents(current.lines, current.tax),
        });
        replacePhoto(null);
        commit(newDraft());
        // What was just sent is now the most recent property, and its item
        // names are suggestions for the next receipt.
        setPhase((p) => {
          if (p.kind !== "in") return p;
          const known = new Set(p.start.itemNames.map(fold));
          const learned = [...new Set(payload.lines.map((line) => line.name))].filter((name) => !known.has(fold(name)));
          return {
            kind: "in",
            start: {
              ...p.start,
              recentPropertyIds: [payload.propertyId, ...p.start.recentPropertyIds.filter((pid) => pid !== payload.propertyId)],
              itemNames: [...learned, ...p.start.itemNames],
            },
          };
        });
        window.history.replaceState({ cleanerStep: "home" }, "");
        window.scrollTo(0, 0);
        return;
      }
      case "signed-out":
        // Nothing was recorded, so the key is still unused. After the code,
        // the receipt is back as it was.
        commit({ ...(draftRef.current ?? attempt), unconfirmedSend: false });
        setPhase({ kind: "code" });
        return;
      case "refused":
        // Nothing was recorded, so the key is still unused.
        commit({ ...(draftRef.current ?? attempt), unconfirmedSend: false });
        if (result.code === "ENTRY_PROPERTY_NOT_FOUND") {
          changeReceipt((d) => ({ ...d, propertyId: null, propertyName: null }));
          openView("picker");
          setNotice(PROPERTY_GONE);
        } else if (result.code !== null && PHOTO_CODES.has(result.code)) {
          replacePhoto(null);
          changeReceipt((d) => ({ ...d, photoKey: null }));
          openView("camera");
          setNotice(PHOTO_REFUSED);
        } else {
          setSendMessage(REFUSED);
        }
        return;
      case "not-sent":
        setSendMessage(result.offline ? OFFLINE : NOT_CONFIRMED);
        return;
    }
  };

  // ── Before a cleaner is in ──

  if (phase.kind === "loading") {
    return (
      <div className={styles.app}>
        <CleanerBar />
        <main className={styles.centered} aria-busy="true">
          <span className={styles.spinner} aria-label="Loading" />
        </main>
      </div>
    );
  }

  if (phase.kind === "code") {
    return (
      <div className={styles.app}>
        <CodeScreen onCode={submitCode} />
      </div>
    );
  }

  if (phase.kind === "offline" || phase.kind === "failed") {
    return (
      <div className={styles.app}>
        <CleanerBar />
        <main className={styles.centered}>
          <p className={styles.centeredMessage} role="alert">
            {phase.kind === "offline" ? "No connection." : "Something went wrong."}
          </p>
          <button type="button" className={styles.primary} onClick={retry}>
            Try again
          </button>
        </main>
      </div>
    );
  }

  // ── In ──

  const { start } = phase;

  // A handyman's flow is its own (dispatch 24); the offline bar is shared.
  if (start.cleaner.role === "handyman") {
    return (
      <div className={styles.app}>
        {!online && (
          <p className={styles.offlineBar} role="status">
            <CloudOff aria-hidden />
            <span>No signal. Nothing you type is lost.</span>
          </p>
        )}
        <HandymanApp key={start.cleaner.id} start={start} onSignedOut={() => setPhase({ kind: "code" })} />
      </div>
    );
  }

  const current = draft;
  if (!current) {
    return (
      <div className={styles.app}>
        <CleanerBar />
        <main className={styles.centered} aria-busy="true">
          <span className={styles.spinner} aria-label="Loading" />
        </main>
      </div>
    );
  }
  const allJobs = jobs ?? start.jobs;
  const step = reachable(current.step, current);
  const propertyName = current.propertyId === null ? null : (start.properties.find((p) => p.id === current.propertyId)?.name ?? current.propertyName);
  const property = current.propertyId === null ? null : { name: propertyName };
  const photos = new Map(start.properties.map((p) => [p.id, p.photo]));

  let screen;
  if (view === "camera") {
    screen = (
      <CameraScreen
        onCapture={takePhoto}
        onFile={takePhoto}
        onClose={closeView}
        preparing={photoState.kind === "preparing"}
        problem={photoState.kind === "error" ? PHOTO_PROBLEMS[photoState.problem] : null}
        notice={notice}
      />
    );
  } else if (view === "picker") {
    screen = (
      <PropertyScreen
        properties={start.properties}
        recentPropertyIds={start.recentPropertyIds}
        selectedId={current.propertyId}
        onChoose={chooseProperty}
        onBack={closeView}
      />
    );
  } else if (view === "history") {
    screen = (
      <HistoryScreen
        properties={start.properties}
        jobs={allJobs}
        today={start.today}
        busyId={jobBusy}
        messages={jobMessages}
        onUndo={(job) => actOnJob(job, "undo")}
        onBack={closeView}
        onSignedOut={historySignedOut}
      />
    );
  } else if (sent) {
    screen = (
      <DoneScreen
        sent={sent}
        onDone={() => setSent(null)}
        onAnother={() => {
          setSent(null);
          startReceipt(receiptProperty(allJobs, start.today), false);
        }}
      />
    );
  } else if (step === "receipt") {
    screen = (
      <ReceiptScreen
        property={property}
        photoUrl={photo?.url ?? null}
        lines={current.lines}
        itemNames={start.itemNames}
        reading={readingStatus(current, readingPhotoKey)}
        tax={current.tax}
        taxFromReading={current.taxFromReading}
        showProblems={showProblems}
        sending={sending}
        sendMessage={sendMessage}
        totalCents={totalCents(current.lines, current.tax)}
        onBack={stepBack}
        onChangeLine={changeLine}
        onChangeTax={changeTax}
        onAddLine={addLine}
        onRemoveLine={removeLine}
        onSend={() => send(propertyName ?? "Property")}
        onStartOver={startOver}
        onChangeProperty={() => openView("picker")}
        onRetake={() => openView("camera")}
      />
    );
  } else {
    screen = (
      <HomeScreen
        cleanerName={start.cleaner.name}
        kind="receipt"
        unsent={isEmptyDraft(current) ? null : { propertyName }}
        properties={start.properties}
        recentPropertyIds={start.recentPropertyIds}
        onUnit={(unit) => startReceipt({ id: unit.id, name: unit.name }, true)}
        onAdd={() => startReceipt(receiptProperty(allJobs, start.today), false)}
        onHistory={() => openView("history")}
        jobs={
          <JobsSection
            jobs={homeJobs(allJobs, start.today)}
            today={start.today}
            busyId={jobBusy}
            messages={jobMessages}
            onMark={(job) => actOnJob(job, "mark")}
            onUndo={(job) => actOnJob(job, "undo")}
            onAddReceipt={(job) => startReceipt({ id: job.propertyId, name: job.propertyName }, true)}
            photoOf={(id) => photos.get(id) ?? null}
          />
        }
      />
    );
  }

  return (
    <div className={styles.app}>
      {!online && (
        <p className={styles.offlineBar} role="status">
          <CloudOff aria-hidden />
          <span>No signal. Nothing you type is lost.</span>
        </p>
      )}
      {notice && view !== "camera" && (
        <p className={styles.notice} role="alert">
          {notice}
        </p>
      )}
      {!kept && !sent && view === null && step === "receipt" && (
        <p className={styles.note}>This phone can’t keep a copy. Keep this page open until it is sent.</p>
      )}
      {screen}
    </div>
  );
}
