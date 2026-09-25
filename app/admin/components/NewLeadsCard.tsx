"use client";

/**
 * The dashboard's lead count: how many contact submissions are still "new",
 * linking to the inbox.
 *
 * Nobody worked these leads before the inbox existed, so the count sits with
 * the property stats rather than behind a menu. It comes from the same list
 * read as the inbox. A count that could not be read is shown as a failure —
 * never as 0, which would look like an empty inbox.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ArrowRight, Inbox } from "lucide-react";
import { fetchLeads } from "@/app/lib/leads-client";
import styles from "../page.module.css";

type CountState =
  | { kind: "loading" }
  | { kind: "ready"; count: number }
  | { kind: "error"; title: string };

export function NewLeadsCard() {
  const [state, setState] = useState<CountState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    fetchLeads().then((result) => {
      if (cancelled) return;
      setState(
        result.ok
          ? { kind: "ready", count: result.data.filter((lead) => lead.status === "new").length }
          : { kind: "error", title: result.title },
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const tone =
    state.kind === "error"
      ? styles.statCardAlert
      : state.kind === "ready" && state.count > 0
        ? styles.statCardAccent
        : "";

  return (
    <Link
      href="/admin/leads?status=new"
      className={`${styles.statCard} ${styles.statCardLink} ${tone}`}
      aria-busy={state.kind === "loading"}
    >
      <div className={styles.statIcon}>
        {state.kind === "error" ? <AlertTriangle size={20} /> : <Inbox size={20} />}
      </div>
      <div className={styles.statContent}>
        <span className={styles.statValue}>
          {state.kind === "ready" ? state.count : state.kind === "loading" ? "…" : "Unavailable"}
        </span>
        <span className={styles.statLabel}>
          {state.kind === "error" ? "New leads could not be read" : "New leads"}
        </span>
        {state.kind === "error" && <span className={styles.statDetail}>{state.title}</span>}
      </div>
      <ArrowRight size={16} className={styles.statArrow} aria-hidden />
    </Link>
  );
}
