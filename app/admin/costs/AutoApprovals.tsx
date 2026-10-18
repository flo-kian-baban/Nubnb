"use client";

/**
 * The review queue's automatic approvals not yet looked at, folded into one compact list (the Costs page, round 1):
 * under what needs a decision, one line with their count and total, "Mark these n seen" (one request: the page's
 * markSeenMany), and Show, which opens the list — a thumbnail of each receipt, the property, the total, the day.
 *
 * The thumbnails' links are asked for in one request when the list is opened (each lasts a minute, and the image is
 * loaded the moment the link comes, as the entry pane's is); a receipt whose link has run out shows its icon. A click
 * on a row opens the entry under it, as the queue's table does.
 */

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, Eye, ImageIcon } from "lucide-react";
import { fetchReceiptLinks } from "@/app/lib/costs-client";
import { formatCents, type CostEntryView } from "@/app/lib/cleaners/model";
import { propertyLabel, shortDay, sentDay } from "@/app/lib/costs/report";
import styles from "./AutoApprovals.module.css";

interface Props {
  entries: CostEntryView[];
  /** The entry open under its row, if any. */
  selectedId: string | null;
  onToggle: (id: string) => void;
  /** The open entry's pane. */
  pane: (entry: CostEntryView) => ReactNode;
  /** Mark them all seen in one request; true while it runs. */
  onMarkAll: () => void;
  marking: boolean;
}

const LINKS_PER_REQUEST = 100;

export function AutoApprovals({ entries, selectedId, onToggle, pane, onMarkAll, marking }: Props) {
  const [open, setOpen] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const totalCents = entries.reduce((sum, entry) => sum + (entry.linesNow.kind === "ok" ? entry.linesNow.totalCents : 0), 0);
  const withPhoto = entries.filter((entry) => (entry.receipts?.length ?? 0) > 0).map((entry) => entry.id);
  const missing = withPhoto.filter((id) => links[id] === undefined && !failed.has(id));
  const wantKey = open ? missing.join(",") : "";

  // The thumbnails' links, asked for once the list is open: a hundred a request.
  useEffect(() => {
    if (wantKey === "") return;
    let cancelled = false;
    const ids = wantKey.split(",");
    (async () => {
      for (let i = 0; i < ids.length; i += LINKS_PER_REQUEST) {
        const chunk = ids.slice(i, i + LINKS_PER_REQUEST);
        const result = await fetchReceiptLinks(chunk);
        if (cancelled) return;
        if (result.ok) setLinks((was) => ({ ...was, ...Object.fromEntries(Object.entries(result.data.links).map(([id, link]) => [id, link.url])) }));
        setFailed((was) => new Set([...was, ...chunk.filter((id) => !result.ok || result.data.links[id] === undefined)]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wantKey]);

  if (entries.length === 0) return null;
  return (
    <section className={styles.block} aria-label="Approved automatically, not yet looked at">
      <div className={styles.head}>
        <button
          type="button"
          className={styles.fold}
          aria-expanded={open}
          onClick={() => {
            // Closed, its links are dropped: they last a minute, so opening again asks for fresh ones.
            if (open) {
              setLinks({});
              setFailed(new Set());
            }
            setOpen(!open);
          }}
        >
          <ChevronRight size={14} aria-hidden className={open ? styles.chevronOpen : styles.chevron} />
          <span className={styles.title}>Approved automatically, not yet looked at</span>
          <span className={styles.figure}>
            {entries.length} · {formatCents(totalCents)}
          </span>
        </button>
        <button type="button" className={styles.markAll} disabled={marking} onClick={onMarkAll} title="Each already counts in its ledger. Seen takes it out of the queue: one request for all of them.">
          <Eye size={14} aria-hidden />
          <span>{marking ? "Marking…" : `Mark these ${entries.length} seen`}</span>
        </button>
      </div>
      {open && (
        <ul className={styles.list}>
          {entries.map((entry) => {
            const day = sentDay(entry.createdAt);
            const url = links[entry.id];
            return (
              <Fragment key={entry.id}>
                <li>
                  <button type="button" id={`entry-${entry.id}`} className={`${styles.row} ${entry.id === selectedId ? styles.rowOpen : ""}`} aria-expanded={entry.id === selectedId} onClick={() => onToggle(entry.id)}>
                    <span className={styles.thumb}>
                      {url ? (
                        // A signed link that lasts a minute, loaded at once; a plain img, as the entry pane's receipt is.
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={url} alt="" loading="eager" decoding="async" onError={() => setFailed((was) => new Set([...was, entry.id]))} />
                      ) : (
                        <ImageIcon size={16} aria-label={(entry.receipts?.length ?? 0) > 0 ? "Receipt photo" : "No receipt photo"} />
                      )}
                    </span>
                    <span className={styles.property} title={propertyLabel(entry)}>
                      {propertyLabel(entry)}
                    </span>
                    <span className={styles.total}>{entry.linesNow.kind === "ok" ? formatCents(entry.linesNow.totalCents) : "—"}</span>
                    <span className={styles.day}>{day ? shortDay(day) : "—"}</span>
                  </button>
                </li>
                {entry.id === selectedId && <li className={styles.pane}>{pane(entry)}</li>}
              </Fragment>
            );
          })}
        </ul>
      )}
    </section>
  );
}
