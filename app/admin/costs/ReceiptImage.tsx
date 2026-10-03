"use client";

/**
 * An entry's receipt photo, through a link that works for 60 seconds.
 *
 * Receipts have no public URL. On opening, this asks the admin API for a
 * signed link to the one object, puts it straight into the image, and keeps
 * it nowhere else — not in the address bar, not in storage. The image loads
 * at once, so the link's minute is ample; copied out of the page, it stops
 * working within that minute. "Full size" enlarges the same image element,
 * already loaded, rather than fetching it again.
 *
 * A link that could not be had is "Could not load the receipt", never "no
 * receipt". An object that carries a permanent download token — minted
 * outside the app — is flagged, and left as it is.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, Maximize2, RefreshCw, X } from "lucide-react";
import { fetchReceiptLink } from "@/app/lib/costs-client";
import styles from "./page.module.css";

type LinkState =
  | { kind: "loading" }
  | { kind: "ready"; url: string; seconds: number; publicToken: boolean }
  | { kind: "error"; title: string; detail?: string; status: number }
  /** The link came, but the image did not load: it expired first, or the object cannot be read. */
  | { kind: "broken" };

export function ReceiptImage({ entryId }: { entryId: string }) {
  const [link, setLink] = useState<LinkState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [large, setLarge] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetchReceiptLink(entryId).then((result) => {
      if (cancelled) return;
      setLink(
        result.ok
          ? { kind: "ready", url: result.data.url, seconds: result.data.seconds, publicToken: result.data.publicToken }
          : { kind: "error", title: result.title, detail: result.detail, status: result.status },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [entryId, attempt]);

  // Escape closes the full-size view.
  useEffect(() => {
    if (!large) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLarge(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [large]);

  const again = () => {
    setLarge(false);
    setLink({ kind: "loading" });
    setAttempt((n) => n + 1);
  };

  if (link.kind === "loading") {
    return (
      <div className={styles.receiptState} aria-busy="true">
        <span className={styles.smallSpinner} aria-hidden />
        <span>Opening the receipt…</span>
      </div>
    );
  }

  if (link.kind === "error" || link.kind === "broken") {
    return (
      <div className={`${styles.receiptState} ${styles.receiptError}`} role="alert">
        <AlertTriangle size={16} aria-hidden />
        <div>
          <p className={styles.receiptErrorTitle}>
            {link.kind === "error" ? "Could not load the receipt" : "The receipt image did not load"}
          </p>
          <p className={styles.note}>
            {link.kind === "error"
              ? `${link.title}${link.detail ? ` ${link.detail}` : ""}${
                  link.status === 401 || link.status === 403
                    ? " Your admin session may have expired — reload and sign in again."
                    : ""
                }`
              : "Its link may have run out before it loaded. Load it again for a new link."}
          </p>
          <button type="button" className={styles.btnGhost} onClick={again}>
            <RefreshCw size={14} />
            <span>{link.kind === "error" ? "Retry" : "Load again"}</span>
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      {link.publicToken && (
        <p className={styles.noteWarn} role="alert">
          This receipt has a permanent public link (a Firebase download token). This page did not make it and has
          not changed it; it was most likely made by opening the receipt in the Firebase console.
        </p>
      )}
      {/* One image element throughout: full size only changes its frame, so it is never fetched twice. */}
      <figure className={`${styles.receipt} ${large ? styles.receiptLarge : ""}`}>
        <button
          type="button"
          className={styles.receiptButton}
          onClick={() => setLarge((was) => !was)}
          aria-label={large ? "Close the full-size receipt" : "Show the receipt full size"}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={link.url} alt="The receipt photo" referrerPolicy="no-referrer" onError={() => setLink({ kind: "broken" })} />
        </button>
        {large ? (
          <button type="button" className={styles.receiptClose} onClick={() => setLarge(false)}>
            <X size={16} aria-hidden />
            <span>Close</span>
          </button>
        ) : (
          <figcaption className={styles.receiptCaption}>
            <button
              type="button"
              className={styles.linkButton}
              onClick={() => setLarge(true)}
              title={`Shown through a link that stops working ${link.seconds} seconds after it was made. It is not kept.`}
            >
              <Maximize2 size={13} aria-hidden />
              <span>Full size</span>
            </button>
          </figcaption>
        )}
      </figure>
    </div>
  );
}
