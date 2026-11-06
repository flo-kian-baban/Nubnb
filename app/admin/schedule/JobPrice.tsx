"use client";

/**
 * "Price for this job", in Assign and Change cleaner (Kian's instruction of 2026-11-06): the job's own amount when it
 * has one, else the unit's cleaning price for the job's tier, with the unit's other cleaning prices one tap away (the
 * price control of the Add a job pass, its tier held), a note under it ("Short-term cleaning price · 3 nights"), and,
 * for a unit with no price for that tier, "Also save as this unit's <tier> cleaning price". Read-only once the job's
 * money counts ("Locked: already counted"). What it sends with the cleaner is `toSend()`: nothing unless the admin
 * changed it (app/lib/schedule/job-price.ts).
 */

import { useEffect, useState } from "react";
import { jobTier, type CleaningPrices } from "@/app/lib/cleanings/prices";
import { readAmountCents } from "@/app/lib/cleanings/model";
import { fetchAmountStart } from "@/app/lib/schedule-client";
import type { JobView } from "@/app/lib/schedule/model";
import type { LastTyped } from "@/app/lib/schedule/add-job";
import { canSaveCleaningPrice, jobMoneyCounts, jobPriceStart, jobPriceToSend, jobPriceWords, saveCleaningPriceWords } from "@/app/lib/schedule/job-price";
import { Tick } from "../property/editor/controls";
import { PriceField } from "./PriceField";
import styles from "./page.module.css";

export type PriceToSend = { price: string | null; saveCleaningPrice: boolean };

export function useJobPrice(job: JobView, prices: CleaningPrices | null) {
  const [start] = useState(() => jobPriceStart(job, prices));
  const [amount, setAmount] = useState(start);
  const [save, setSave] = useState(false);
  const [lastTyped, setLastTyped] = useState<LastTyped | null>(null);
  const tier = jobTier(job);
  const locked = jobMoneyCounts(job);
  const offerSave = canSaveCleaningPrice(job, prices);
  // A unit with no cleaning price for the tier: what was last typed there, read once, as the grey placeholder.
  useEffect(() => {
    if (!offerSave) return;
    let cancelled = false;
    fetchAmountStart(job.propertyId).then((result) => {
      if (!cancelled && result.ok) setLastTyped(result.data.lastTyped);
    });
    return () => {
      cancelled = true;
    };
  }, [offerSave, job.propertyId]);
  const cents = amount.trim() === "" ? null : readAmountCents(amount);
  return {
    tier,
    amount,
    setAmount,
    save,
    setSave,
    lastTyped,
    locked,
    offerSave,
    words: jobPriceWords(job, prices, lastTyped, amount, cents, save),
    /** What Save sends with the cleaner, or why it cannot. */
    toSend: () => jobPriceToSend(job, start, amount, cents, save),
  };
}

export function JobPriceBlock({ job, prices, price, busy, said }: { job: JobView; prices: CleaningPrices | null; price: ReturnType<typeof useJobPrice>; busy: boolean; said: string | null }) {
  return (
    <div className={styles.priceBlock}>
      <span className={styles.dialogLabel}>Price for this job</span>
      <PriceField
        id={`job-price-${job.id}`}
        label="Price for this job"
        state="ready"
        prices={prices}
        lastTyped={price.lastTyped ?? { short: null, mid: null, long: null }}
        tier={price.tier}
        amount={price.amount}
        onChange={(next) => price.setAmount(next.amount)}
        words={price.words}
        fixedTier
        locked={price.locked}
        disabled={busy}
      />
      {price.offerSave && (
        <div className={styles.saveRow}>
          <Tick checked={price.save} onChange={() => price.setSave(!price.save)} label={saveCleaningPriceWords(price.tier)} disabled={busy} />
          <span>{saveCleaningPriceWords(price.tier)}</span>
        </div>
      )}
      {said && (
        <p className={styles.warn} role="alert">
          {said}
        </p>
      )}
    </div>
  );
}
