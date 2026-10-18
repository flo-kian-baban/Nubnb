"use client";

/**
 * The property list's Income and Cleaning cells (Kian's rulings of 2026-10-15, part A of
 * PROPERTY-LIST-COLUMNS-PLAN.md), drawn as the Statement cell is: the whole cell a link to where the work is, the
 * detail in the tooltip. Quiet unless they need something (Kian's rulings of 2026-10-17, admin home): a badge and
 * its month or day only in red or amber; anything else — received, assigned, done, nothing due — in quiet words, so
 * the rows with colour are the ones that need something. What each says, app/lib/income/standing.ts and
 * app/lib/schedule/standing.ts decide; nothing here does.
 *
 * And the row's Next step (app/lib/home/next-step.ts): the one most pressing action, a link to where it is done, or
 * "Up to date" in quiet words.
 */

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { addDays, dayText } from "@/app/lib/availability/days";
import { monthName } from "@/app/lib/reports/model";
import type { IncomeStanding, IncomeTone } from "@/app/lib/income/standing";
import type { CleaningStanding, CleaningTone } from "@/app/lib/schedule/standing";
import type { NextStep } from "@/app/lib/home/next-step";
import { propertyMonthHref } from "./StatementStatus";
import shared from "../page.module.css";
import cells from "./StatementStatus.module.css";

/** Only red and amber are drawn as badges; every other tone is quiet (null). */
const INCOME_CLASS: Record<IncomeTone, string | null> = { problem: shared.statePastDue, warning: shared.stateDue, done: null, none: null };
const CLEANING_CLASS: Record<CleaningTone, string | null> = { problem: shared.statePastDue, warning: shared.stateDue, assigned: null, done: null, none: null };

const editSection = (propertyId: string, section: string) => `/admin/property/edit?id=${encodeURIComponent(propertyId)}&section=${section}`;

/** Where an Income cell leads: the Income page at the month, the property's page at the month, or its Airbnb title. */
function incomeHref(propertyId: string, s: IncomeStanding): string {
  if (s.target === "title" || s.month === null) return editSection(propertyId, "airbnbTitle");
  if (s.target === "income") return `/admin/income?month=${s.month}&property=${encodeURIComponent(propertyId)}`;
  return propertyMonthHref(propertyId, s.month);
}

/**
 * Where a Cleaning cell leads: the Schedule on this property, from the job's day when it is older than the Schedule's
 * own first day (a week back); with no calendar link, the edit page's Calendar section.
 */
function cleaningHref(propertyId: string, s: CleaningStanding, today: string): string {
  if (s.key === "not-read") return editSection(propertyId, "calendar");
  const from = s.day !== null && s.day < addDays(today, -7) ? `&from=${s.day}` : "";
  return `/admin/schedule?property=${encodeURIComponent(propertyId)}${from}`;
}

/** `quietWhen`: whether quiet words keep their day or month (a job's day does; the Income column's month is every row's). */
function Cell({ href, title, label, badgeClass, when, quietWhen }: { href: string; title: string; label: string; badgeClass: string | null; when: string | null; quietWhen: boolean }) {
  return (
    <Link href={href} prefetch={false} className={cells.cell} title={title}>
      {badgeClass === null ? (
        <span className={cells.quiet}>
          {label}
          {quietWhen && when && ` · ${when}`}
        </span>
      ) : (
        <>
          <span className={`${shared.stateBadge} ${badgeClass}`}>{label}</span>
          {when && <span className={cells.month}>{when}</span>}
        </>
      )}
    </Link>
  );
}

export function IncomeCell({ propertyId, standing }: { propertyId: string; standing: IncomeStanding }) {
  return (
    <Cell
      href={incomeHref(propertyId, standing)}
      title={standing.title}
      label={standing.label}
      badgeClass={INCOME_CLASS[standing.tone]}
      when={standing.month === null ? null : monthName(standing.month)}
      quietWhen={false}
    />
  );
}

export function CleaningCell({ propertyId, standing, today }: { propertyId: string; standing: CleaningStanding; today: string }) {
  return (
    <Cell
      href={cleaningHref(propertyId, standing, today)}
      title={standing.title}
      label={standing.label}
      badgeClass={CLEANING_CLASS[standing.tone]}
      when={standing.day === null ? null : dayText(standing.day)}
      quietWhen
    />
  );
}

/** A row's Next step: a link to where it is done, or "Up to date" in quiet words. */
export function NextStepCell({ step }: { step: NextStep }) {
  if (step.href === null) {
    return (
      <span className={cells.quiet} title={step.title}>
        {step.label}
      </span>
    );
  }
  return (
    <Link href={step.href} prefetch={false} className={cells.step} title={step.title}>
      <span>{step.label}</span>
      <ArrowRight size={13} aria-hidden />
    </Link>
  );
}

/** Not known yet, or not known at all: "…" while the read runs, "—" when it failed, its reason in the tooltip. */
export function UnknownCell({ failed }: { failed: string | null }) {
  return failed === null ? (
    <span className={shared.locationText} aria-busy>
      …
    </span>
  ) : (
    <span className={shared.locationText} title={failed}>
      —
    </span>
  );
}
