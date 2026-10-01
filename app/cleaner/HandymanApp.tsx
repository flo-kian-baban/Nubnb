"use client";

/**
 * The handyman's flow (dispatch 24), at the same /cleaner page: the start
 * route says the account's role, and CleanerApp hands over here.
 *
 *   property → work → sent
 *
 * The same shape as the cleaner's flow, without the photo, the items and
 * the reading: the draft lives on the phone (work-draft.ts) until the
 * server confirms it; each step forward is a history entry, so the phone's
 * Back goes to the step before; a send carries the draft's one-time key,
 * so sending again after a lost answer is safe. "My work" lists their own
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
import { PropertyScreen } from "./PropertyScreen";
import { WorkScreen } from "./WorkScreen";
import { DoneScreen, type SentReceipt } from "./DoneScreen";
import { ReceiptsScreen } from "./ReceiptsScreen";
import styles from "./cleaner.module.css";

interface HandymanAppProps {
  start: CleanerStart;
  /** The session ended: back to the code screen. */
  onSignedOut: () => void;
}

const OFFLINE = "No signal. Your work is saved on this phone. Send it when you have signal.";
const NOT_CONFIRMED = "Not confirmed. Tap Send again — it won’t be counted twice.";
const PROPERTY_GONE = "That property is no longer on the list. Choose it again.";
const REFUSED = "This couldn’t be saved. Check the description and the price and send again.";

function reachable(step: WorkStep, draft: WorkDraft): WorkStep {
  return draft.propertyId === null ? "property" : step;
}

/** The first field with a problem, into view and focused. */
function showFirstProblem() {
  const card = document.querySelector<HTMLElement>('[data-problem="true"]');
  card?.scrollIntoView({ behavior: "smooth", block: "center" });
  card?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus({ preventScroll: true });
}

export function HandymanApp({ start, onSignedOut }: HandymanAppProps) {
  const id = start.cleaner.id;
  const [draft, setDraftState] = useState<WorkDraft>(() => {
    const stored = loadWorkDraft(id) ?? newWorkDraft();
    return { ...stored, step: reachable(stored.step, stored) };
  });
  const [kept, setKept] = useState(true);
  const [sent, setSent] = useState<SentReceipt | null>(null);
  const [sending, setSending] = useState(false);
  const [sendMessage, setSendMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [showProblems, setShowProblems] = useState(false);
  /** True while "My work" is open over the current step. */
  const [viewing, setViewing] = useState(false);
  const [recent, setRecent] = useState(start.recentPropertyIds);

  const draftRef = useRef(draft);
  const stepsPushedRef = useRef(0);

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

  // The phone's Back: the step before, as far as the draft allows.
  useEffect(() => {
    const onPopState = (event: PopStateEvent) => {
      stepsPushedRef.current = Math.max(0, stepsPushedRef.current - 1);
      setViewing(event.state?.workView === "list");
      const requested: unknown = event.state?.workStep;
      setSent(null);
      setNotice(null);
      commit({ ...draftRef.current, step: reachable(requested === "work" ? "work" : "property", draftRef.current) });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [commit]);

  const goTo = (step: WorkStep) => {
    setNotice(null);
    commit({ ...draftRef.current, step: reachable(step, draftRef.current) });
    window.history.pushState({ workStep: step }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  const stepBack = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setNotice(null);
    commit({ ...draftRef.current, step: "property" });
    window.history.replaceState({ workStep: "property" }, "");
    window.scrollTo(0, 0);
  };

  const openList = () => {
    setNotice(null);
    setViewing(true);
    window.history.pushState({ workStep: draftRef.current.step, workView: "list" }, "");
    stepsPushedRef.current += 1;
    window.scrollTo(0, 0);
  };

  const closeList = () => {
    if (stepsPushedRef.current > 0) {
      window.history.back();
      return;
    }
    setViewing(false);
    window.history.replaceState({ workStep: draftRef.current.step }, "");
    window.scrollTo(0, 0);
  };

  const listSignedOut = useCallback(() => {
    setViewing(false);
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

  const chooseProperty = (property: CleanerProperty) => {
    if (draftRef.current.propertyId !== property.id) change({ propertyId: property.id, propertyName: property.name });
    goTo("work");
  };

  const startOver = () => {
    if (!window.confirm("Clear this? What you typed will be removed.")) return;
    setShowProblems(false);
    setSendMessage(null);
    setNotice(null);
    commit(newWorkDraft());
    window.history.replaceState({ workStep: "property" }, "");
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
        window.history.replaceState({ workStep: "property" }, "");
        window.scrollTo(0, 0);
        return;
      case "signed-out":
        commit({ ...draftRef.current, unconfirmedSend: false });
        onSignedOut();
        return;
      case "refused":
        commit({ ...draftRef.current, unconfirmedSend: false });
        if (result.code === "ENTRY_PROPERTY_NOT_FOUND") {
          goTo("property");
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

  const property = start.properties.find((p) => p.id === draft.propertyId);
  const propertyName = property?.name ?? draft.propertyName ?? "Property";

  let screen;
  if (viewing) {
    screen = <ReceiptsScreen properties={start.properties} onBack={closeList} onSignedOut={listSignedOut} title="My work" tag="Work" />;
  } else if (sent) {
    screen = <DoneScreen sent={sent} onAnother={() => setSent(null)} onMyReceipts={openList} anotherLabel="Log more work" listLabel="See my work" tag="Work" />;
  } else if (draft.step === "property") {
    screen = (
      <PropertyScreen
        cleanerName={start.cleaner.name}
        properties={start.properties}
        recentPropertyIds={recent}
        selectedId={draft.propertyId}
        onChoose={chooseProperty}
        onMyReceipts={openList}
        listLabel="My work"
        tag="Work"
      />
    );
  } else {
    screen = (
      <WorkScreen
        propertyName={propertyName}
        draft={draft}
        problems={showProblems ? workProblems(draft) : {}}
        sending={sending}
        sendMessage={sendMessage}
        onBack={stepBack}
        onChange={change}
        onSend={() => send(propertyName)}
        onStartOver={startOver}
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
      {!kept && !sent && !viewing && draft.step !== "property" && (
        <p className={styles.note}>This phone can’t keep a copy. Keep this page open until it is sent.</p>
      )}
      {screen}
    </>
  );
}
