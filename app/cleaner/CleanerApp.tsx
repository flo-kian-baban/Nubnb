"use client";

/**
 * The cleaner app: one page, one step at a time.
 *
 *   code → property → photo → items → sent
 *
 * "My receipts" (dispatch 19) opens from the property and sent screens: the
 * cleaner's own receipts and what became of each. It is a view over the
 * steps, not a step: the draft is untouched, and Back returns to where the
 * cleaner was.
 *
 * ── State ──
 * Before a cleaner is in, the app is loading, on the code screen, or unable
 * to reach the server. Once in, the receipt being worked on is the draft
 * (cleaner-draft.ts), written to the phone on every change and cleared only
 * when the server confirms it. The step is part of the draft, so a reopened
 * page lands where the cleaner left off, after the code if their session
 * ended.
 *
 * ── Back ──
 * Each step forward adds a history entry, so the phone's Back button goes to
 * the step before rather than out of the app. A step shows only when the
 * receipt has what it needs: no photo without a property, no items without
 * a photo.
 *
 * ── Sending ──
 * A send carries the draft's one-time key. Whatever happens to the answer —
 * no signal, a timeout, a server failure — sending again is safe: a receipt
 * that already arrived is reported as sent and nothing is written twice. A
 * receipt changed after a send whose outcome is unknown gets a new key.
 *
 * A cleaner never reaches /admin from here, and never sees another cleaner's
 * work: the API gives this page their own name and recent properties, the
 * property list, and item names as words only.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { CloudOff } from "lucide-react";
import {
  loadStart,
  sendEntry,
  signIn,
  signOut,
  type SignInResult,
  type StartResult,
} from "@/app/lib/cleaner-client";
import {
  STEPS,
  clearDraft,
  clearPhoto,
  isEmptyDraft,
  loadDraft,
  loadPhoto,
  newDraft,
  newLine,
  newSubmissionKey,
  saveDraft,
  savePhoto,
  toEntryPayload,
  totalCents,
  type Draft,
  type DraftLine,
  type Step,
  type StoredPhoto,
} from "@/app/lib/cleaner-draft";
import type { PreparedPhoto } from "@/app/lib/receipt-photo";
import type { CleanerProperty, CleanerStart } from "@/app/lib/cleaners/model";
import { fold } from "@/app/lib/cleaners/text";
import { CodeScreen } from "./CodeScreen";
import { PropertyScreen } from "./PropertyScreen";
import { PhotoScreen } from "./PhotoScreen";
import { ItemsScreen } from "./ItemsScreen";
import { DoneScreen, type SentReceipt } from "./DoneScreen";
import { ReceiptsScreen } from "./ReceiptsScreen";
import styles from "./cleaner.module.css";

type Phase =
  | { kind: "loading" }
  | { kind: "code" }
  | { kind: "offline" }
  | { kind: "failed" }
  | { kind: "in"; start: CleanerStart };

/** The draft's photo, with an object URL to show it by. */
interface PhotoInHand extends StoredPhoto {
  url: string;
}

const OFFLINE = "No signal. Your receipt is saved on this phone. Send it when you have signal.";
const NOT_CONFIRMED = "Not confirmed. Tap Send again — it won’t be counted twice.";
const PROPERTY_GONE = "That property is no longer on the list. Choose it again.";
const PHOTO_REFUSED = "That photo couldn’t be used. Take it again.";
const REFUSED = "This receipt couldn’t be saved. Check each item and send again.";

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

/** The furthest of `step` and the steps before it that this draft can show. */
function reachable(step: Step, draft: Draft): Step {
  if (draft.propertyId === null) return "property";
  if (step === "items" && draft.photoKey !== null) return "items";
  return step === "property" ? "property" : "photo";
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
  card?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
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
  /** True while "My receipts" is open over the current step. */
  const [viewing, setViewing] = useState(false);
  const online = useSyncExternalStore(subscribeToConnection, () => navigator.onLine, () => true);

  // The latest draft and cleaner for handlers that run between renders:
  // Back, and the steps of a send. Written only by the handlers below.
  const draftRef = useRef<Draft | null>(null);
  const cleanerIdRef = useRef<string | null>(null);
  const photoUrlRef = useRef<string | null>(null);
  /** History entries this page has added and not yet gone back over. */
  const stepsPushedRef = useRef(0);

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
      setViewing(false);
      window.history.replaceState({ cleanerStep: step }, "");
      setPhase({ kind: "in", start });
    },
    [commit, replacePhoto],
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

  // The phone's Back: the step before, as far as the draft allows.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      stepsPushedRef.current = Math.max(0, stepsPushedRef.current - 1);
      setViewing(event.state?.cleanerView === "receipts");
      const current = draftRef.current;
      if (!current || !cleanerIdRef.current) return;
      const requested: unknown = event.state?.cleanerStep;
      setSent(null);
      setNotice(null);
      commit({ ...current, step: reachable(isStep(requested) ? requested : "property", current) });
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

  const submitCode = async (code: string): Promise<SignInResult["kind"]> => {
    const result = await signIn(code);
    if (result.kind !== "ok") return result.kind;
    const start = await loadStart();
    // Signed in, yet not: the phone did not keep the session cookie.
    if (start.kind === "signed-out") return "failed";
    await enter(start);
    return "ok";
  };

  const leave = async () => {
    if (!(await signOut())) {
      setNotice("Couldn’t sign out. Check the signal and try again.");
      return;
    }
    // The draft stays on the phone for this cleaner's next sign-in.
    cleanerIdRef.current = null;
    draftRef.current = null;
    replacePhoto(null);
    setDraftState(null);
    setSent(null);
    setNotice(null);
    setViewing(false);
    setPhase({ kind: "code" });
  };

  /** "My receipts", as a new history entry over the current step, so Back closes it. */
  const openReceipts = () => {
    setNotice(null);
    setViewing(true);
    window.history.pushState({ cleanerStep: draftRef.current?.step ?? "property", cleanerView: "receipts" }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  /** The list's own Back: the phone's Back when this page added the entry, else closed in place. */
  const closeReceipts = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setViewing(false);
    window.history.replaceState({ cleanerStep: draftRef.current?.step ?? "property" }, "");
    window.scrollTo(0, 0);
  };

  /** The session ended while the list was open: the code, then back to the receipt as it was. */
  const receiptsSignedOut = useCallback(() => {
    setViewing(false);
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
   * The screen's own Back. Over an entry this page added, it is the phone's
   * Back; on a page reopened mid-receipt there is none behind, so the step
   * before is shown in place instead of leaving the app.
   */
  const stepBack = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    const current = draftRef.current;
    if (!current) return;
    const previous: Step = current.step === "items" ? "photo" : "property";
    setNotice(null);
    commit({ ...current, step: previous });
    window.history.replaceState({ cleanerStep: previous }, "");
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

  const chooseProperty = (property: CleanerProperty) => {
    if (draftRef.current?.propertyId !== property.id) {
      changeReceipt((d) => ({ ...d, propertyId: property.id, propertyName: property.name }));
    }
    goTo("photo");
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
    changeReceipt((d) => ({ ...d, photoKey: stored.photoKey }));
    const saved = await savePhoto(id, stored);
    setKept((was) => (saved ? was : false));
  };

  const changeLine = (key: string, change: Partial<Omit<DraftLine, "key">>) => {
    changeReceipt((d) => ({ ...d, lines: d.lines.map((line) => (line.key === key ? { ...line, ...change } : line)) }));
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
    setShowProblems(false);
    setSendMessage(null);
    setNotice(null);
    commit(newDraft());
    window.history.replaceState({ cleanerStep: "property" }, "");
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
      goTo("photo");
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

    const result = await sendEntry(payload, photo.blob, photo.name, (done) => setSending(done));
    setSending(null);

    switch (result.kind) {
      case "sent": {
        clearDraft(id);
        void clearPhoto(id);
        setSent({
          propertyName,
          lineCount: payload.lines.length,
          totalCents: totalCents(current.lines),
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
        window.history.replaceState({ cleanerStep: "property" }, "");
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
          goTo("property");
          setNotice(PROPERTY_GONE);
        } else if (result.code !== null && PHOTO_CODES.has(result.code)) {
          replacePhoto(null);
          changeReceipt((d) => ({ ...d, photoKey: null }));
          goTo("photo");
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
  const current = draft;
  if (!current) {
    return (
      <div className={styles.app}>
        <main className={styles.centered} aria-busy="true">
          <span className={styles.spinner} aria-label="Loading" />
        </main>
      </div>
    );
  }
  const property = start.properties.find((p) => p.id === current.propertyId);
  const propertyName = property?.name ?? current.propertyName ?? "Property";

  let screen;
  if (viewing) {
    screen = <ReceiptsScreen properties={start.properties} onBack={closeReceipts} onSignedOut={receiptsSignedOut} />;
  } else if (sent) {
    screen = <DoneScreen sent={sent} onAnother={() => setSent(null)} onMyReceipts={openReceipts} />;
  } else if (current.step === "property") {
    screen = (
      <PropertyScreen
        cleanerName={start.cleaner.name}
        properties={start.properties}
        recentPropertyIds={start.recentPropertyIds}
        selectedId={current.propertyId}
        onChoose={chooseProperty}
        onMyReceipts={openReceipts}
        onSignOut={leave}
      />
    );
  } else if (current.step === "photo") {
    screen = (
      <PhotoScreen
        propertyName={propertyName}
        photoUrl={photo?.url ?? null}
        onBack={stepBack}
        onPhoto={acceptPhoto}
        onNext={() => goTo("items")}
      />
    );
  } else {
    screen = (
      <ItemsScreen
        propertyName={propertyName}
        photoUrl={photo?.url ?? null}
        lines={current.lines}
        itemNames={start.itemNames}
        showProblems={showProblems}
        sending={sending}
        sendMessage={sendMessage}
        totalCents={totalCents(current.lines)}
        onBack={stepBack}
        onChangeLine={changeLine}
        onAddLine={addLine}
        onRemoveLine={removeLine}
        onSend={() => send(propertyName)}
        onStartOver={startOver}
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
      {notice && (
        <p className={styles.notice} role="alert">
          {notice}
        </p>
      )}
      {!kept && !sent && !viewing && current.step !== "property" && (
        <p className={styles.note}>This phone can’t keep a copy. Keep this page open until it is sent.</p>
      )}
      {screen}
    </div>
  );
}
