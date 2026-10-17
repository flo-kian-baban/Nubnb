"use client";

/**
 * The handyman's flow (dispatch 24), at the same /cleaner page: the start
 * route says the account's role, and CleanerApp hands over here.
 *
 *   home → (property) → work → sent
 *
 * The home screen (Kian's rulings of 2026-10-16 and 2026-10-17) lists every
 * unit, "All units", recent ones first, where a tap starts work for that
 * unit; then one button, "Add work", and History on its bar; no pay. A
 * handyman has no jobs, so nothing is prefilled: "Add work" opens the
 * property list, and the chosen property then sits in bold above Send, with
 * Change, as on a cleaner's receipt. Work begun and not sent is opened again
 * instead of a new piece.
 *
 * The same shape as the cleaner's flow, without the photo, the items and
 * the reading: the draft lives on the phone (work-draft.ts) until the
 * server confirms it; each screen opened is a history entry, so the phone's
 * Back goes to the screen before; a send carries the draft's one-time key,
 * so sending again after a lost answer is safe. History lists their own
 * entries and what became of each, through the same list route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { sendWork } from "@/app/lib/cleaner-client";
import { newSubmissionKey } from "@/app/lib/cleaner-draft";
import {
  clearWorkDraft,
  isEmptyWorkDraft,
  loadWorkDraft,
  newWorkDraft,
  readPrice,
  saveWorkDraft,
  toWorkPayload,
  workProblems,
  type WorkDraft,
  type WorkStep,
} from "@/app/lib/work-draft";
import type { CleanerProperty, CleanerStart } from "@/app/lib/cleaners/model";
import { HomeScreen } from "./HomeScreen";
import { PropertyScreen } from "./PropertyScreen";
import { WorkScreen } from "./WorkScreen";
import { DoneScreen, type SentReceipt } from "./DoneScreen";
import { HistoryScreen } from "./HistoryScreen";
import styles from "./cleaner.module.css";

interface HandymanAppProps {
  start: CleanerStart;
  /** The session ended: back to the code screen. */
  onSignedOut: () => void;
}

/** A screen over the step: the property list, History. */
type View = "picker" | "history";

const OFFLINE = "No signal. Your work is saved on this phone. Send it when you have signal.";
const NOT_CONFIRMED = "Not confirmed. Tap Send again — it won’t be counted twice.";
const PROPERTY_GONE = "That property is no longer on the list. Choose it again.";
const REFUSED = "This couldn’t be saved. Check the description and the price and send again.";
const UNSENT = "This work is not sent yet. Send it first, then add the next.";

const NO_JOBS: never[] = [];
const NO_MESSAGES: Record<string, string> = {};

/** Work with something typed in it: what the home screen offers to finish. A property alone is not begun. */
function begun(draft: WorkDraft): boolean {
  return draft.description.trim() !== "" || draft.price.trim() !== "";
}

/** The first field with a problem, into view and focused. */
function showFirstProblem() {
  const card = document.querySelector<HTMLElement>('[data-problem="true"]');
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  // A field marked invalid; at the property, its Choose button.
  (card?.querySelector<HTMLElement>('[aria-invalid="true"]') ?? card?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
}

export function HandymanApp({ start, onSignedOut }: HandymanAppProps) {
  const id = start.cleaner.id;
  const [draft, setDraftState] = useState<WorkDraft>(() => loadWorkDraft(id) ?? newWorkDraft());
  const [kept, setKept] = useState(true);
  const [sent, setSent] = useState<SentReceipt | null>(null);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** The property list or History, open over the step; null when none is. */
  const [view, setView] = useState<View | null>(null);
  const [recent, setRecent] = useState(start.recentPropertyIds);

  const draftRef = useRef(draft);
  const stepsPushedRef = useRef(0);
  /** The step the property list opened over: from home, a choice turns its entry into the work's; from the work, Back. */
  const pickerOverRef = useRef<WorkStep>("home");

  const commit = useCallback(
    (next: WorkDraft) => {
      draftRef.current = next;
      setDraftState(next);
      if (isEmptyWorkDraft(next)) {
        clearWorkDraft(id);
        return;
      }
      setKept((was) => (saveWorkDraft(id, next) ? was : false));
    },
    [id],
  );

  useEffect(() => {
    window.history.replaceState({ workStep: draftRef.current.step }, "");
  }, []);

  // The phone's Back: the screen before.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      stepsPushedRef.current = Math.max(0, stepsPushedRef.current - 1);
      const requestedView: unknown = event.state?.workView;
      setView(requestedView === "picker" || requestedView === "history" ? requestedView : null);
      const requested: unknown = event.state?.workStep;
      setSent(null);
      setNotice(null);
      commit({ ...draftRef.current, step: requested === "work" ? "work" : "home" });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [commit]);

  const goTo = (step: WorkStep) => {
    setNotice(null);
    commit({ ...draftRef.current, step });
    window.history.pushState({ workStep: step }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  /** The work's own Back: home. On a page reopened mid-work there is no entry behind, so home is shown in place. */
  const stepBack = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setNotice(null);
    commit({ ...draftRef.current, step: "home" });
    window.history.replaceState({ workStep: "home" }, "");
    window.scrollTo(0, 0);
  };

  /** Open the property list or History over the step, as a new history entry, so Back closes it. */
  const openView = (next: View) => {
    const step = draftRef.current.step;
    if (next === "picker") pickerOverRef.current = step;
    setView(next);
    window.history.pushState({ workStep: step, workView: next }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  const closeView = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setView(null);
    window.history.replaceState({ workStep: draftRef.current.step }, "");
    window.scrollTo(0, 0);
  };

  const historySignedOut = useCallback(() => {
    setView(null);
    onSignedOut();
  }, [onSignedOut]);

  /** Any change to the work itself. After a send with no answer, it is new work: a new key. */
  const change = (patch: Partial<WorkDraft>) => {
    const current = draftRef.current;
    let next = { ...current, ...patch };
    if (current.unconfirmedSend) next = { ...next, submissionKey: newSubmissionKey(), unconfirmedSend: false };
    setSendMessage(null);
    commit(next);
  };

  /** "Add work": the property list first, as nothing is prefilled; work begun and not sent is opened instead. */
  const addWork = () => {
    if (begun(draftRef.current)) goTo("work");
    else openView("picker");
  };

  /** A unit tapped in "All units": work for it. Work begun and not sent is opened instead, taking the unit if it has none. */
  const startWorkFor = (property: CleanerProperty) => {
    const current = draftRef.current;
    if (begun(current)) {
      goTo("work");
      if (current.propertyId === null) change({ propertyId: property.id, propertyName: property.name });
      else if (current.propertyId !== property.id) setNotice(UNSENT);
      return;
    }
    change({ propertyId: property.id, propertyName: property.name });
    goTo("work");
  };

  const chooseProperty = (property: CleanerProperty) => {
    if (draftRef.current.propertyId !== property.id) change({ propertyId: property.id, propertyName: property.name });
    setNotice(null);
    if (pickerOverRef.current === "home") {
      // From home: the list's entry becomes the work's, so Back from the work is home.
      setView(null);
      commit({ ...draftRef.current, step: "work" });
      window.history.replaceState({ workStep: "work" }, "");
      window.scrollTo(0, 0);
      return;
    }
    closeView();
  };

  const startOver = () => {
    if (!window.confirm("Clear this? What you typed will be removed.")) return;
    setShowProblems(false);
    setSendMessage(null);
    setNotice(null);
    commit(newWorkDraft());
    window.history.replaceState({ workStep: "home" }, "");
    window.scrollTo(0, 0);
  };

  const send = async (propertyName: string) => {
    const current = draftRef.current;
    if (sending) return;
    const payload = toWorkPayload(current);
    if (!payload) {
      setShowProblems(true);
      requestAnimationFrame(showFirstProblem);
      return;
    }
    if (!navigator.onLine) {
      setSendMessage(OFFLINE);
      return;
    }
    setShowProblems(false);
    setSendMessage(null);
    setSending(true);
    const attempt: WorkDraft = { ...current, unconfirmedSend: true };
    commit(attempt);
    const result = await sendWork(payload);
    setSending(false);

    switch (result.kind) {
      case "sent":
        clearWorkDraft(id);
        setSent({ propertyName, lineCount: 1, totalCents: readPrice(current.price)?.cents ?? 0, kind: "work" });
        commit(newWorkDraft());
        setRecent((was) => [payload.propertyId, ...was.filter((pid) => pid !== payload.propertyId)]);
        window.history.replaceState({ workStep: "home" }, "");
        window.scrollTo(0, 0);
        return;
      case "signed-out":
        commit({ ...draftRef.current, unconfirmedSend: false });
        onSignedOut();
        return;
      case "refused":
        commit({ ...draftRef.current, unconfirmedSend: false });
        if (result.code === "ENTRY_PROPERTY_NOT_FOUND") {
          change({ propertyId: null, propertyName: null });
          openView("picker");
          setNotice(PROPERTY_GONE);
        } else {
          setSendMessage(REFUSED);
        }
        return;
      case "not-sent":
        setSendMessage(result.offline ? OFFLINE : NOT_CONFIRMED);
        return;
    }
  };

  const propertyName = draft.propertyId === null ? null : (start.properties.find((p) => p.id === draft.propertyId)?.name ?? draft.propertyName);

  let screen;
  if (view === "picker") {
    screen = <PropertyScreen properties={start.properties} recentPropertyIds={recent} selectedId={draft.propertyId} onChoose={chooseProperty} onBack={closeView} />;
  } else if (view === "history") {
    screen = (
      <HistoryScreen
        properties={start.properties}
        jobs={NO_JOBS}
        today={start.today}
        busyId={null}
        messages={NO_MESSAGES}
        onUndo={() => {}}
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
          addWork();
        }}
        anotherLabel="Add more work"
      />
    );
  } else if (draft.step === "work") {
    screen = (
      <WorkScreen
        property={draft.propertyId === null ? null : { name: propertyName }}
        draft={draft}
        problems={showProblems ? workProblems(draft) : {}}
        propertyProblem={showProblems && draft.propertyId === null}
        sending={sending}
        sendMessage={sendMessage}
        onBack={stepBack}
        onChange={change}
        onChangeProperty={() => openView("picker")}
        onSend={() => send(propertyName ?? "Property")}
        onStartOver={startOver}
      />
    );
  } else {
    screen = (
      <HomeScreen
        cleanerName={start.cleaner.name}
        kind="work"
        unsent={begun(draft) ? { propertyName } : null}
        properties={start.properties}
        recentPropertyIds={recent}
        onUnit={startWorkFor}
        onAdd={addWork}
        onHistory={() => openView("history")}
      />
    );
  }

  return (
    <>
      {notice && (
        <p className={styles.notice} role="alert">
          {notice}
        </p>
      )}
      {!kept && !sent && view === null && draft.step === "work" && (
        <p className={styles.note}>This phone can’t keep a copy. Keep this page open until it is sent.</p>
      )}
      {screen}
    </>
  );
}
