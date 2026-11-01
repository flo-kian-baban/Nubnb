"use client";

/**
 * A cleaner's jobs on their home screen (Kian's rulings of 2026-10-16): today's and tomorrow's, with Mark cleaned, and
 * before them any job whose checkout has passed that they can still mark, or marked today (homeJobs,
 * app/lib/cleaner-home.ts). Jobs marked on an earlier day are in History.
 *
 * One card per job (Kian's ruling of 2026-10-17: the public site's look): the unit's cover photo across the top, its
 * stored 400-pixel copy rounded as the public cards, with the public site's blue badges on it — Today, Tomorrow,
 * Same-day turnover (the next guest arrives on the checkout day), Cleaned — then the day, the property by its name for
 * cleaners, its checkout time and when the next guest arrives, and what can be done. Mark cleaned opens on the checkout day; it is one tap, with no amount and no photo
 * (the cleaning schedule, 2026-10-14). A job whose booking changed says so and cannot be marked: "Cancelled: don't
 * go", or "Moved to <day>" (Kian's ruling R2 of 2026-10-19), else "Don't go unless the office asks". A cleaned job reads
 * "Cleaned · Undo" — Undo while no finished statement prints its cleaning and no payment covers its day — with "Add a
 * receipt for this unit" (ruling 6). A mark whose cleaning the office deleted or removed reads "Removed by the office",
 * with no Undo, until the office reopens it; then the job reads Mark cleaned again.
 *
 * Mark cleaned opens a short form on the card (Kian's ruling F of 2026-11-01): an optional note, and "Ask for extra",
 * which needs a reason and has no amount field. With it, the card reads "Cleaned · extra asked" in amber and "Sent to
 * Nubnb": never an amount, never the outcome. No amount is shown anywhere in this app (ruling H).
 */

import { useState } from "react";
import { Camera, Check, X } from "lucide-react";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import type { MarkDetails } from "@/app/lib/cleaner-client";
import type { CleanerProperty } from "@/app/lib/cleaners/model";
import { dayText } from "@/app/lib/availability/days";
import { changedWords, jobBadges } from "@/app/lib/cleaner-home";
import styles from "./cleaner.module.css";
import { UnitPhoto } from "./UnitList";

interface JobsSectionProps {
  /** The home screen's jobs, soonest first (homeJobs). */
  jobs: CleanerJobView[];
  today: string;
  /** The job whose mark or undo is in flight. */
  busyId: string | null;
  /** A refusal or a lost answer, under the job it is about. */
  messages: Record<string, string>;
  onMark: (job: CleanerJobView, details: MarkDetails) => void;
  onUndo: (job: CleanerJobView) => void;
  /** "Add a receipt for this unit": a receipt starting on this job's property. */
  onAddReceipt: (job: CleanerJobView) => void;
  /** A property's cover as its stored small copies, from the start call's list; null for none. */
  photoOf: (propertyId: string) => CleanerProperty["photo"];
}

/** "Wed, Oct 14". */
export const weekday = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00`));

/** The day under the photo: the date itself when a Today or Tomorrow badge says which day it is. */
function dayLine(job: CleanerJobView, today: string): string {
  if (job.checkout < today) return `Checkout was ${weekday(job.checkout)}`;
  return weekday(job.checkout);
}


function guestLine(job: CleanerJobView, today: string): string | null {
  if (!job.nextCheckIn) return null;
  const time = job.checkInTime ? ` ${job.checkInTime}` : "";
  if (job.nextCheckIn === job.checkout) return `Next guest ${job.checkout === today ? "today" : "the same day"}${time}`;
  return `Next guest ${dayText(job.nextCheckIn)}`;
}

/** What a marked job says: "Cleaned · Undo" (ruling 6), "Cleaned · extra asked" in amber with "Sent to Nubnb" (ruling F), or the office's removal. Shared with History. */
export function CleanedLine({ job, busy, disabled, onUndo }: { job: CleanerJobView; busy: boolean; disabled: boolean; onUndo: () => void }) {
  if (job.markRefusal === "removed") {
    return (
      <p className={`${styles.jobState} ${styles.jobStateRemoved}`}>
        <X aria-hidden />
        <span>Removed by the office</span>
      </p>
    );
  }
  const extra = job.extraAsked === true;
  return (
    <>
      <p className={`${styles.jobState} ${extra ? styles.jobStateExtra : ""}`}>
        <Check aria-hidden />
        <span>{extra ? "Cleaned · extra asked" : "Cleaned"}</span>
        {job.canUndo && (
          <>
            <span aria-hidden> · </span>
            <button type="button" className={styles.inlineButton} onClick={onUndo} disabled={disabled}>
              {busy ? "Undoing…" : "Undo"}
            </button>
          </>
        )}
      </p>
      {extra && <p className={styles.jobSent}>Sent to Nubnb</p>}
    </>
  );
}

/**
 * The short form Mark cleaned opens (Kian's ruling F): a note, optional; "Ask for extra", with its reason, required
 * when asked; then Mark cleaned. No amount field, and no amount anywhere (ruling H).
 */
function MarkForm({ busy, onMark, onCancel }: { busy: boolean; onMark: (details: MarkDetails) => void; onCancel: () => void }) {
  const [note, setNote] = useState("");
  const [extra, setExtra] = useState(false);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const submit = () => {
    if (extra && reason.trim() === "") {
      setProblem("Say why you are asking for extra.");
      return;
    }
    onMark({ note: note.trim() === "" ? null : note.trim(), extraReason: extra ? reason.trim() : null });
  };
  return (
    <div className={styles.markForm} role="group" aria-label="Mark cleaned">
      <label className={styles.markLabel}>
        <span className={styles.fieldLabel}>Note for the office (optional)</span>
        <textarea className={`${styles.field} ${styles.markText}`} value={note} maxLength={300} rows={2} placeholder="Anything the office should know" onChange={(e) => setNote(e.target.value)} disabled={busy} />
      </label>
      <button
        type="button"
        className={`${styles.markToggle} ${extra ? styles.markToggleOn : ""}`}
        aria-pressed={extra}
        onClick={() => {
          setExtra((on) => !on);
          setProblem(null);
        }}
        disabled={busy}
      >
        <span className={styles.markToggleBox} aria-hidden>
          {extra && <Check />}
        </span>
        <span>Ask for extra</span>
      </button>
      {extra && (
        <label className={styles.markLabel}>
          <span className={styles.fieldLabel}>Why?</span>
          <textarea
            className={`${styles.field} ${styles.markText} ${problem ? styles.fieldInvalid : ""}`}
            value={reason}
            maxLength={300}
            rows={2}
            placeholder="What needed extra work"
            aria-invalid={problem ? true : undefined}
            onChange={(e) => {
              setReason(e.target.value);
              setProblem(null);
            }}
            disabled={busy}
          />
        </label>
      )}
      {problem && (
        <p className={styles.fieldProblem} role="alert">
          {problem}
        </p>
      )}
      <button type="button" className={styles.primary} onClick={submit} disabled={busy} aria-busy={busy || undefined}>
        {busy ? "Saving…" : "Mark cleaned"}
      </button>
      <button type="button" className={styles.textButton} onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

export function JobsSection({ jobs, today, busyId, messages, onMark, onUndo, onAddReceipt, photoOf }: JobsSectionProps) {
  /** The job whose mark form is open; one at a time. */
  const [marking, setMarking] = useState<string | null>(null);
  return (
    <section aria-labelledby="jobs-heading" className={styles.jobs}>
      <h2 id="jobs-heading" className={styles.sectionLabel}>
        Your jobs
      </h2>
      {jobs.length === 0 ? (
        <p className={styles.jobsEmpty}>No jobs today or tomorrow.</p>
      ) : (
        <ul className={styles.jobList}>
          {jobs.map((job) => {
            const changed = job.status === "booking-changed";
            const marked = job.markedAt !== null;
            const removed = job.markRefusal === "removed";
            const guest = guestLine(job, today);
            const badges = jobBadges(job, today);
            return (
              <li key={job.id} className={`${styles.jobCard} ${changed && !marked ? styles.jobCardChanged : ""}`}>
                <div className={styles.jobPhotoWrap}>
                  <UnitPhoto src={photoOf(job.propertyId)?.card ?? null} className={styles.jobPhoto} />
                  {badges.length > 0 && (
                    <p className={styles.badges}>
                      {badges.map((badge) => (
                        <span key={badge} className={styles.badge}>
                          {badge}
                        </span>
                      ))}
                    </p>
                  )}
                </div>
                <div className={styles.jobBody}>
                  <p className={styles.jobDay}>
                    {dayLine(job, today)}
                    {changed && !changedWords(job).plain && <span className={styles.jobChanged}> · Booking changed</span>}
                  </p>
                  <p className={styles.jobProperty}>
                    <span className={styles.propertyName}>{job.propertyName ?? "Property"}</span>
                    {job.city && <span className={styles.propertyCity}>{job.city}</span>}
                  </p>
                  {!changed && (
                    <p className={styles.jobTimes}>
                      Checkout {job.checkOutTime ?? ""}
                      {guest && ` · ${guest}`}
                    </p>
                  )}
                  {marked ? (
                    <>
                      <CleanedLine job={job} busy={busyId === job.id} disabled={busyId !== null} onUndo={() => onUndo(job)} />
                      {changed && !removed && <p className={styles.jobNote}>The booking changed after it was marked. The office decides.</p>}
                      {!removed && (
                        <button type="button" className={styles.secondary} onClick={() => onAddReceipt(job)}>
                          <Camera aria-hidden />
                          <span>Add a receipt for this unit</span>
                        </button>
                      )}
                    </>
                  ) : changed ? (
                    <p className={changedWords(job).plain ? styles.jobChangedNote : styles.jobNote}>{changedWords(job).words}</p>
                  ) : job.markRefusal === "too-early" ? (
                    <p className={styles.jobNote}>Mark cleaned opens {weekday(job.checkout)}</p>
                  ) : job.markRefusal === null ? (
                    marking === job.id ? (
                      <MarkForm
                        busy={busyId === job.id}
                        onMark={(details) => {
                          onMark(job, details);
                          setMarking(null);
                        }}
                        onCancel={() => setMarking(null)}
                      />
                    ) : (
                      <button type="button" className={styles.primary} onClick={() => setMarking(job.id)} disabled={busyId !== null} aria-busy={busyId === job.id || undefined}>
                        {busyId === job.id ? "Saving…" : "Mark cleaned"}
                      </button>
                    )
                  ) : null}
                  {messages[job.id] && (
                    <p className={styles.jobMessage} role="alert">
                      {messages[job.id]}
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
