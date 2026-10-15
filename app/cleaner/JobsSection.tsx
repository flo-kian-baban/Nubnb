"use client";

/**
 * A cleaner's jobs, first on their screen, above everything else (the cleaning schedule, Kian's rulings of
 * 2026-10-14): the jobs they are on and have not marked, soonest first — one whose checkout has passed heads the
 * list — then the ones they marked, newest first.
 *
 * One card per job: the day, the property by its name for cleaners, its checkout time and when the next guest
 * arrives, and one action. Mark cleaned opens on the checkout day; it is one tap, with no amount and no photo (rulings
 * 4 and 7). A job whose booking changed says so and cannot be marked. Undo stays on a marked job while no finished
 * statement prints its cleaning, within the 45 days the list reaches. A mark whose cleaning the office deleted or
 * removed stays among the done, "Removed by the office", with no Undo, until the office reopens it (Kian's ruling of
 * 2026-10-14, night); then the job is back on top with Mark cleaned.
 */

import { Check, X } from "lucide-react";
import type { CleanerJobView } from "@/app/lib/schedule/model";
import { addDays, dayText } from "@/app/lib/availability/days";
import styles from "./cleaner.module.css";

interface JobsSectionProps {
  jobs: CleanerJobView[];
  today: string;
  /** The job whose mark or undo is in flight. */
  busyId: string | null;
  /** A refusal or a lost answer, under the job it is about. */
  messages: Record<string, string>;
  onMark: (job: CleanerJobView) => void;
  onUndo: (job: CleanerJobView) => void;
}

/** "Wed, Oct 14". */
const weekday = (day: string) => new Intl.DateTimeFormat("en-CA", { weekday: "short", month: "short", day: "numeric" }).format(new Date(`${day}T12:00:00`));

function dayLine(job: CleanerJobView, today: string): string {
  if (job.checkout === today) return `Today · ${weekday(job.checkout)}`;
  if (job.checkout === addDays(today, 1)) return `Tomorrow · ${weekday(job.checkout)}`;
  if (job.checkout < today) return `Checkout was ${weekday(job.checkout)}`;
  return weekday(job.checkout);
}

function guestLine(job: CleanerJobView, today: string): string | null {
  if (!job.nextCheckIn) return null;
  const time = job.checkInTime ? ` ${job.checkInTime}` : "";
  if (job.nextCheckIn === job.checkout) return `Next guest ${job.checkout === today ? "today" : "the same day"}${time}`;
  return `Next guest ${dayText(job.nextCheckIn)}`;
}

export function JobsSection({ jobs, today, busyId, messages, onMark, onUndo }: JobsSectionProps) {
  const open = jobs.filter((job) => job.markedAt === null).sort((a, b) => a.checkout.localeCompare(b.checkout));
  const done = jobs.filter((job) => job.markedAt !== null).sort((a, b) => b.checkout.localeCompare(a.checkout));
  if (open.length === 0 && done.length === 0) return null;

  return (
    <section aria-labelledby="jobs-heading" className={styles.jobs}>
      {/* Only marked ones left: "Done" stands alone, with no empty heading over it. */}
      <h2 id="jobs-heading" className={styles.sectionLabel}>
        {open.length > 0 ? "Your jobs" : "Done"}
      </h2>
      {open.length > 0 && (
        <ul className={styles.jobList}>
          {open.map((job) => {
            const changed = job.status === "booking-changed";
            const guest = guestLine(job, today);
            return (
              <li key={job.id} className={`${styles.jobCard} ${changed ? styles.jobCardChanged : ""}`}>
                <p className={styles.jobDay}>
                  {dayLine(job, today)}
                  {changed && <span className={styles.jobChanged}> · Booking changed</span>}
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
                {changed ? (
                  <p className={styles.jobNote}>Don’t go unless the office asks.</p>
                ) : job.markRefusal === "too-early" ? (
                  <p className={styles.jobNote}>Mark cleaned opens {weekday(job.checkout)}</p>
                ) : job.markRefusal === null ? (
                  <button type="button" className={styles.primary} onClick={() => onMark(job)} disabled={busyId !== null} aria-busy={busyId === job.id || undefined}>
                    {busyId === job.id ? "Saving…" : "Mark cleaned"}
                  </button>
                ) : null}
                {messages[job.id] && (
                  <p className={styles.jobMessage} role="alert">
                    {messages[job.id]}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {done.length > 0 && (
        <>
          {open.length > 0 && <h3 className={styles.jobDoneLabel}>Done</h3>}
          <ul className={styles.jobDoneList}>
            {done.map((job) => {
              const removed = job.markRefusal === "removed";
              return (
                <li key={job.id} className={styles.jobDoneRow}>
                  {removed ? <X className={`${styles.jobDoneIcon} ${styles.jobRemovedIcon}`} aria-hidden /> : <Check className={styles.jobDoneIcon} aria-hidden />}
                  <span className={styles.jobDoneText}>
                    {job.propertyName ?? "Property"} · {weekday(job.checkout)}
                    {job.status === "booking-changed" && " · booking changed"}
                  </span>
                  {job.canUndo && (
                    <button type="button" className={styles.textButton} onClick={() => onUndo(job)} disabled={busyId !== null}>
                      {busyId === job.id ? "…" : "Undo"}
                    </button>
                  )}
                  {removed && <span className={styles.jobRemovedNote}>Removed by the office</span>}
                  {messages[job.id] && (
                    <span className={styles.jobMessage} role="alert">
                      {messages[job.id]}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
