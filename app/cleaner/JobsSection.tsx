"use client";

/**
 * A cleaner's jobs on their home screen (Kian's rulings of 2026-10-16; rebuilt to his rulings of 2026-11-02, Build 1
 * of the UX audit): today's and tomorrow's, and before them any job whose checkout has passed that they can still
 * mark, or marked today (homeGroups, app/lib/cleaner-home.ts), each day named once as a heading. Within a day a
 * same-day turnover comes first.
 *
 * One compact card per job (item 1): the unit's small thumbnail, its address, "Checkout 11:00 AM", "Next guest today
 * 4:00 PM" or the next guest's day, and two big buttons: "Done" and "Add receipt" (the unit filled in). No city, no
 * greeting, no repeated day line, no badge: a same-day turnover says so in one amber line.
 *
 * Done (item 2) opens the app's own pop-up (DoneDialog): the unit and day, an optional note for the office, and
 * "Confirm done" / "Cancel". With no note the cleaning counts at once; with a note it is made but its money waits for
 * the office (the note is the reason, through ruling F's extra-asked mechanics). Afterwards the card reads "Cleaned"
 * in green, or "Cleaned · note sent" in amber until the office decides, then "Cleaned" again — never an amount, never
 * the outcome (ruling H). Undo asks once, "Undo Cleaned?" (item 4). Grey words under "Cleaned" when they apply:
 * "Recorded by the office", "Can't undo: already paid", "Can't undo: on a statement".
 *
 * A cancelled or moved booking is one grey line (item 7): "<unit> · Cancelled: don't go", "<unit> · Moved to <day>".
 * A mark the office removed reads "Removed by the office", with no Undo, until the office reopens it.
 */

import { useState } from "react";
import { Camera, Check, X } from "lucide-react";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import type { MarkDetails } from "@/app/lib/cleaner-client";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import { CLEANING_LIMITS } from "@/app/lib/cleanings/model";
import { addDays } from "@/app/lib/availability/days";
import { cardDay, changedWords, cleanedWords, guestWords, homeGroups, isSameDayTurnover } from "@/app/lib/cleaner-home";
import styles from "./cleaner.module.css";
import { AskDialog } from "./AskDialog";
import { UnitPhoto } from "./UnitList";

interface JobsSectionProps {
  /** Their jobs as they now stand; the home's groups are worked out here. */
  jobs: CleanerJobView[];
  today: string;
  /** The job whose mark or undo is in flight. */
  busyId: string | null;
  /** A refusal or a lost answer, under the job it is about. */
  messages: Record<string, string>;
  onMark: (job: CleanerJobView, details: MarkDetails) => void;
  onUndo: (job: CleanerJobView) => void;
  /** "Add receipt": a receipt starting on this job's property. */
  onAddReceipt: (job: CleanerJobView) => void;
  /** A property's cover as its stored small copies, from the start call's list; null for none. */
  photoOf: (propertyId: string) => CleanerProperty["photo"];
}

/** "Wed, Oct 14". */
export const weekday = cardDay;

/** What a marked job says (shared with History): "Cleaned · Undo", "Cleaned · note sent" in amber, the office's removal, and the grey words under it. */
export function CleanedLine({ job, busy, disabled, onUndo }: { job: CleanerJobView; busy: boolean; disabled: boolean; onUndo: () => void }) {
  if (job.markRefusal === "removed") {
    return (
      <p className={`${styles.jobState} ${styles.jobStateRemoved}`}>
        <X aria-hidden />
        <span>Removed by the office</span>
      </p>
    );
  }
  const noted = job.extraAsked === true;
  const words = cleanedWords(job);
  return (
    <>
      <p className={`${styles.jobState} ${noted ? styles.jobStateExtra : ""}`}>
        <Check aria-hidden />
        <span>{noted ? "Cleaned · note sent" : "Cleaned"}</span>
        {job.canUndo && (
          <>
            <span aria-hidden> · </span>
            <button type="button" className={styles.inlineButton} onClick={onUndo} disabled={disabled}>
              {busy ? "Undoing…" : "Undo"}
            </button>
          </>
        )}
      </p>
      {words.length > 0 && <p className={styles.undoWords}>{words.join(" · ")}</p>}
    </>
  );
}

/** The pop-up behind Done (item 2): the unit and day, a note for the office, "Confirm done" and "Cancel". */
function DoneDialog({ job, busy, onConfirm, onCancel }: { job: CleanerJobView; busy: boolean; onConfirm: (details: MarkDetails) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const trimmed = note.trim();
  return (
    <AskDialog
      title="Done?"
      words={
        <>
          <strong>{job.propertyName ?? "Property"}</strong> · {cardDay(job.checkout)}
        </>
      }
      confirmLabel="Confirm done"
      busy={busy}
      onConfirm={() => onConfirm({ note: trimmed === "" ? null : trimmed })}
      onCancel={onCancel}
    >
      <label className={styles.markLabel}>
        <span className={styles.fieldLabel}>Note for the office, e.g. extra work or more time</span>
        <textarea className={`${styles.field} ${styles.markText}`} value={note} maxLength={CLEANING_LIMITS.NOTE_MAX} rows={3} onChange={(e) => setNote(e.target.value)} disabled={busy} />
      </label>
    </AskDialog>
  );
}

/** The pop-up behind Undo (item 4): one question. */
function UndoDialog({ job, busy, onConfirm, onCancel }: { job: CleanerJobView; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  return (
    <AskDialog
      title="Undo Cleaned?"
      words={
        <>
          <strong>{job.propertyName ?? "Property"}</strong> · {cardDay(job.checkout)}
        </>
      }
      confirmLabel="Undo"
      cancelLabel="Keep it"
      busy={busy}
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  );
}

export function JobsSection({ jobs, today, busyId, messages, onMark, onUndo, onAddReceipt, photoOf }: JobsSectionProps) {
  /** The job whose Done pop-up is open, and the one whose Undo question is; one at a time. */
  const [marking, setMarking] = useState<string | null>(null);
  const [undoing, setUndoing] = useState<string | null>(null);
  const groups = homeGroups(jobs, today);
  const markingJob = marking === null ? null : (jobs.find((job) => job.id === marking) ?? null);
  const undoingJob = undoing === null ? null : (jobs.find((job) => job.id === undoing) ?? null);

  const card = (job: CleanerJobView) => {
    const changed = job.status === "booking-changed";
    const marked = job.markedAt !== null;
    const removed = job.markRefusal === "removed";
    // A cancelled or moved booking: one grey line, nothing to press (item 7).
    if (changed && !marked) {
      const { words, plain } = changedWords(job);
      return (
        <li key={job.id} className={styles.jobLine}>
          <span className={styles.jobLineName}>{job.propertyName ?? "Property"}</span>
          <span className={styles.jobLineWords}>
            {plain ? words : `Booking changed · ${words}`}
          </span>
        </li>
      );
    }
    const guest = guestWords(job, today);
    const sameDay = isSameDayTurnover(job);
    const canMark = !changed && job.markRefusal === null;
    return (
      <li key={job.id} className={styles.jobRow}>
        <div className={styles.jobHead}>
          <UnitPhoto src={photoOf(job.propertyId)?.thumb ?? null} className={styles.jobThumb} />
          <div className={styles.jobMain}>
            <p className={styles.jobAddress}>{job.propertyName ?? "Property"}</p>
            {/* A job the office added by hand says what it is (Build 2): its label, not a checkout. */}
            <p className={styles.jobMeta}>
              {job.label ? `${job.label}${job.checkout < today ? ` · ${cardDay(job.checkout)}` : ""}` : job.checkout < today ? `Checkout was ${cardDay(job.checkout)}` : job.checkOutTime ? `Checkout ${job.checkOutTime}` : "Checkout"}
              {!job.label && guest && !sameDay && ` · ${guest}`}
            </p>
            {sameDay && <p className={styles.sameDay}>Same-day turnover{guest ? ` · ${guest}` : ""}</p>}
          </div>
        </div>
        {marked ? (
          <>
            <CleanedLine job={job} busy={busyId === job.id} disabled={busyId !== null} onUndo={() => setUndoing(job.id)} />
            {changed && !removed && <p className={styles.jobNote}>The booking changed after it was marked. The office decides.</p>}
            {!removed && (
              <button type="button" className={styles.secondary} onClick={() => onAddReceipt(job)}>
                <Camera aria-hidden />
                <span>Add receipt</span>
              </button>
            )}
          </>
        ) : (
          <>
            {job.markRefusal === "too-early" && <p className={styles.jobNote}>Done opens {job.checkout === addDays(today, 1) ? "tomorrow" : cardDay(job.checkout)}</p>}
            <div className={styles.jobButtons}>
              {canMark && (
                <button type="button" className={styles.primary} onClick={() => setMarking(job.id)} disabled={busyId !== null} aria-busy={busyId === job.id || undefined}>
                  {busyId === job.id ? "Saving…" : "Done"}
                </button>
              )}
              <button type="button" className={styles.secondary} onClick={() => onAddReceipt(job)}>
                <Camera aria-hidden />
                <span>Add receipt</span>
              </button>
            </div>
          </>
        )}
        {messages[job.id] && (
          <p className={styles.jobMessage} role="alert">
            {messages[job.id]}
          </p>
        )}
      </li>
    );
  };

  return (
    <section aria-labelledby="jobs-heading" className={styles.jobs}>
      <h2 id="jobs-heading" className={styles.visuallyHidden}>
        Your jobs
      </h2>
      {groups.length === 0 ? (
        <p className={styles.jobsEmpty}>No jobs today or tomorrow.</p>
      ) : (
        groups.map((group) => (
          <div key={group.key} className={styles.jobGroup}>
            <h3 className={styles.groupHead}>{group.heading}</h3>
            <ul className={styles.jobList}>{group.jobs.map(card)}</ul>
          </div>
        ))
      )}
      {markingJob && (
        <DoneDialog
          job={markingJob}
          busy={busyId === markingJob.id}
          onConfirm={(details) => {
            onMark(markingJob, details);
            setMarking(null);
          }}
          onCancel={() => setMarking(null)}
        />
      )}
      {undoingJob && (
        <UndoDialog
          job={undoingJob}
          busy={busyId === undoingJob.id}
          onConfirm={() => {
            onUndo(undoingJob);
            setUndoing(null);
          }}
          onCancel={() => setUndoing(null)}
        />
      )}
    </section>
  );
}
