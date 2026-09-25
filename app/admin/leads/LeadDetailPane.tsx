"use client";

/**
 * One lead in full, and the inbox's only write: its status.
 *
 * Every field on the document is shown. Name, email, subject, message and —
 * on a stay request — the property, dates and guests each have a place, and
 * anything else the document holds is listed under "Other fields" rather than
 * left out. A field that is not there is shown as absent.
 *
 * A status change is not optimistic. The buttons show the stored status until
 * the server confirms the write, and a failed write is reported in a Notice:
 * the operator is never left looking at a status that was not saved.
 *
 * A lead whose notification email failed, or whose outcome was never
 * recorded, opens with an error Notice: the message was stored, but nobody
 * may have been told it exists.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, ExternalLink, RefreshCw, X } from "lucide-react";
import { NoticeBanner, useNotice, type Notice } from "../components/Notice";
import { changeLeadStatus, fetchLead, type LeadResult } from "@/app/lib/leads-client";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  fieldText,
  isLeadStatus,
  notificationOf,
  otherFields,
  stayOf,
  type LeadDetail,
  type LeadStatus,
  type NotificationRecord,
  type PropertyLink,
} from "@/app/lib/leads";
import { classifySource } from "@/app/lib/inquiry";
import { Absent, FieldText, SourceBadge, StayDate, When } from "./lead-display";
import shared from "../page.module.css";
import styles from "./page.module.css";

type LeadFailure = Extract<LeadResult<unknown>, { ok: false }>;

type DetailState =
  | { kind: "loading" }
  | { kind: "ready"; lead: LeadDetail }
  | ({ kind: "error" } & LeadFailure);

interface LeadDetailPaneProps {
  id: string;
  onStatusChanged: (id: string, status: LeadStatus) => void;
  onClose: () => void;
}

export function LeadDetailPane({ id, onStatusChanged, onClose }: LeadDetailPaneProps) {
  // Mounted with `key={id}`, so opening another lead starts from "loading".
  const [state, setState] = useState<DetailState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState<LeadStatus | null>(null);
  const { notice, show: showNotice, clear: clearNotice } = useNotice();

  useEffect(() => {
    let cancelled = false;
    fetchLead(id).then((result) => {
      if (cancelled) return;
      setState(result.ok ? { kind: "ready", lead: result.data } : { ...result, kind: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [id, attempt]);

  const retry = () => {
    setState({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  const changeStatus = async (next: LeadStatus) => {
    if (saving) return;
    clearNotice();
    setSaving(next);
    const result = await changeLeadStatus(id, next);
    setSaving(null);

    const label = LEAD_STATUS_LABELS[next].toLowerCase();
    if (!result.ok) {
      showNotice({
        tone: "error",
        title: `Could not mark this lead as ${label}.`,
        detail: describeStatusFailure(result),
      });
      return;
    }

    const { status, statusChangedAt } = result.data;
    setState((prev) =>
      prev.kind === "ready"
        ? {
            kind: "ready",
            lead: { ...prev.lead, fields: { ...prev.lead.fields, status, statusChangedAt } },
          }
        : prev,
    );
    onStatusChanged(id, status);
    showNotice({ tone: "success", title: `Marked as ${label}.` });
  };

  if (state.kind === "loading") {
    return (
      <div className={styles.detailState}>
        <div className={shared.spinner} />
        <p>Loading lead…</p>
      </div>
    );
  }

  if (state.kind === "error") {
    const missing = state.status === 404;
    return (
      <div className={`${styles.detailState} ${styles.detailStateError}`} role="alert">
        <AlertTriangle size={28} strokeWidth={1.5} />
        <h2>{missing ? "This lead does not exist" : "Could not load this lead"}</h2>
        <p>
          {missing
            ? "No submission has this ID. It may have been deleted."
            : "The lead could not be read, so nothing about it is shown."}
          {(state.status === 401 || state.status === 403) &&
            " Your admin session may have expired — reload and sign in again."}
        </p>
        <code className={shared.loadErrorDetail}>
          {state.title}
          {state.detail ? ` ${state.detail}` : ""}
        </code>
        <div className={styles.detailStateActions}>
          {!missing && (
            <button type="button" className={shared.btnPrimary} onClick={retry}>
              <RefreshCw size={16} />
              <span>Retry</span>
            </button>
          )}
          <button type="button" className={styles.btnGhost} onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    );
  }

  const { lead } = state;
  const fields = lead.fields;
  const storedStatus = fieldText(fields.status);
  const current = isLeadStatus(fields.status) ? fields.status : null;
  const source = classifySource(fields);
  const notification = notificationOf(fields);
  const unnotifiedNotice = describeUnnotified(notification);
  const stay = stayOf(fields);
  const others = otherFields(fields);
  const email = fieldText(fields.email);
  const message = fieldText(fields.message);

  return (
    <article className={styles.detail} aria-labelledby="lead-detail-title">
      <header className={styles.detailHead}>
        <div className={styles.detailHeadText}>
          <h2 id="lead-detail-title" className={styles.detailTitle}>
            <FieldText value={fieldText(fields.name)} />
          </h2>
          <p className={styles.detailMeta}>
            Received <When iso={fieldText(fields.createdAt)} />
          </p>
        </div>
        <button type="button" className={styles.closeBtn} onClick={onClose} aria-label="Close lead">
          <X size={16} />
        </button>
      </header>

      {unnotifiedNotice && (
        <NoticeBanner notice={unnotifiedNotice} className={styles.unnotifiedNotice} />
      )}

      <section className={styles.statusBlock}>
        <div className={styles.statusGroup} role="group" aria-label="Status">
          {LEAD_STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={`${styles.statusBtn} ${current === s ? styles.statusBtnActive : ""}`}
              aria-pressed={current === s}
              disabled={saving !== null || current === s}
              onClick={() => changeStatus(s)}
            >
              {saving === s ? "Saving…" : LEAD_STATUS_LABELS[s]}
            </button>
          ))}
        </div>
        <p className={styles.statusNote}>
          {current === null &&
            (storedStatus === null ? (
              <>No status is recorded. </>
            ) : (
              <>The stored status, “{storedStatus}”, is not one of these three. </>
            ))}
          {fields.statusChangedAt === undefined ? (
            <>No status change is recorded.</>
          ) : (
            <>
              {/* No closing period: an en-CA time already ends in "a.m."/"p.m." */}
              Status last changed <When iso={fieldText(fields.statusChangedAt)} />
            </>
          )}
        </p>
        <NoticeBanner notice={notice} onDismiss={clearNotice} className={styles.detailNotice} />
      </section>

      <dl className={styles.fields}>
        <Row label="Email">
          {email !== null && isMailable(email) ? (
            <a href={`mailto:${email}`} className={styles.link}>
              {email}
            </a>
          ) : (
            <FieldText value={email} />
          )}
        </Row>
        <Row label="Subject">
          <FieldText value={fieldText(fields.subject)} />
        </Row>
        <Row label="Source">
          <SourceBadge source={source.source} />
          <span className={styles.basis}>{source.basis}</span>
        </Row>
        <Row label="Team notified">
          <NotificationValue record={notification} />
        </Row>
      </dl>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Stay</h3>
        {stay ? (
          <dl className={styles.fields}>
            <Row label="Property">
              <PropertyValue
                name={fieldText(stay.propertyName)}
                id={fieldText(stay.propertyId)}
                link={lead.property}
              />
            </Row>
            <Row label="Check-in">
              <StayDate value={stay.checkIn} />
            </Row>
            <Row label="Check-out">
              <StayDate value={stay.checkOut} />
            </Row>
            <Row label="Guests">
              <FieldText value={fieldText(stay.guests)} />
            </Row>
          </dl>
        ) : (
          <p>
            <Absent label="No property, dates or guests are recorded on this lead." />
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Message</h3>
        {message !== null && message.trim() !== "" ? (
          <p className={styles.message}>{message}</p>
        ) : (
          <FieldText value={message} />
        )}
      </section>

      {others.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.sectionTitle}>Other fields on this document</h3>
          <dl className={styles.fields}>
            {others.map(([key, value]) => (
              <Row key={key} label={key}>
                <span className={styles.mono}>
                  <FieldText value={fieldText(value)} />
                </span>
              </Row>
            ))}
          </dl>
        </section>
      )}

      <p className={styles.docId}>
        Document ID <span className={styles.mono}>{lead.id}</span>
      </p>
    </article>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className={styles.fieldRow}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{children}</dd>
    </div>
  );
}

/** The property a stay request names, and a link to its live listing when it still exists. */
function PropertyValue({
  name,
  id,
  link,
}: {
  name: string | null;
  id: string | null;
  link: PropertyLink | null;
}) {
  return (
    <div className={styles.propertyValue}>
      <span>
        <FieldText value={name} />
      </span>
      {link?.state === "found" &&
        (link.href ? (
          <a href={link.href} target="_blank" rel="noopener noreferrer" className={styles.link}>
            View listing <ExternalLink size={12} aria-hidden />
          </a>
        ) : (
          <span className={styles.note}>The listing has no name, so it has no public page.</span>
        ))}
      {link?.state === "found" && link.name && name !== null && link.name !== name && (
        <span className={styles.note}>Now listed as “{link.name}”.</span>
      )}
      {link?.state === "missing" && <span className={styles.noteWarn}>No listing has this ID now.</span>}
      {link?.state === "unreadable" && (
        <span className={styles.noteWarn}>
          The listing could not be looked up. Reopen the lead to try again.
        </span>
      )}
      {link === null && <span className={styles.note}>No property ID to link from.</span>}
      <span className={styles.mono}>
        ID <FieldText value={id} />
      </span>
    </div>
  );
}

/** Only a plain address becomes a mailto link, so a stored value cannot add headers to it. */
function isMailable(email: string): boolean {
  return /^[^\s@?&#]+@[^\s@?&#]+$/.test(email);
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function describeStatusFailure(failure: LeadFailure): string {
  const why = sentence(`${failure.title}${failure.detail ? ` ${failure.detail}` : ""}`);

  if (failure.status === 401 || failure.status === 403) {
    return `${why} Your admin session may have expired — reload and sign in again. The status was not changed.`;
  }
  // No answer, or an answer that could not be read: the write may or may not
  // have landed, so do not claim either.
  if (failure.status === 0 || (failure.status >= 200 && failure.status < 300)) {
    return `${why} Reload to see the stored status.`;
  }
  return `${why} (HTTP ${failure.status}) The status was not changed.`;
}

/** What is known about the email to the team, in the detail list. */
function NotificationValue({ record }: { record: NotificationRecord }) {
  switch (record.state) {
    case "sent":
      return (
        <div className={styles.propertyValue}>
          <span>
            Emailed <When iso={record.at} />
          </span>
          {record.detail && <span className={styles.mono}>{record.detail}</span>}
        </div>
      );
    case "failed":
      return (
        <div className={styles.propertyValue}>
          <span className={styles.noteError}>
            No — the email failed <When iso={record.at} />
          </span>
          <span className={styles.mono}>
            <FieldText value={record.detail} />
          </span>
        </div>
      );
    case "pending":
      return <span className={styles.noteWarn}>Not confirmed — the outcome was never recorded</span>;
    case "unexpected":
      return (
        <div className={styles.propertyValue}>
          <span className={styles.noteWarn}>Not confirmed — the record is not one the form writes</span>
          <span className={styles.mono}>
            <FieldText value={record.detail} />
          </span>
        </div>
      );
    case "unrecorded":
      return <Absent label="Not recorded — this lead arrived before notifications were tracked." />;
  }
}

/**
 * The Notice for a lead the team may never have heard about, or null. A lead
 * from before notifications were tracked gets none: that is not known to have
 * failed.
 */
function describeUnnotified(record: NotificationRecord): Notice | null {
  switch (record.state) {
    case "failed":
      return {
        tone: "error",
        title: "Nobody was told about this lead.",
        detail: `The message was stored, but the notification email failed${
          record.detail ? `: ${record.detail}` : "."
        }`,
      };
    case "pending":
    case "unexpected":
      return {
        tone: "error",
        title: "Nobody may have been told about this lead.",
        detail:
          "The message was stored, but there is no record that the notification email was sent.",
      };
    default:
      return null;
  }
}
