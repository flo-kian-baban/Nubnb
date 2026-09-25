"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CalendarDays, CheckCircle, Send, Users } from "lucide-react";
import styles from "./page.module.css";
import { DEFAULT_SUBJECT, INQUIRY_SUBJECTS } from "@/app/lib/inquiry";
import type { InquiryOrigin } from "./stay-request";

type FormState = "idle" | "sending" | "success" | "error";

/** Formats an ISO date for display without dragging date-fns into this page. */
function prettyDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-CA", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

export default function ContactForm({ origin }: { origin: InquiryOrigin }) {
  const { stay } = origin;
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState<string>(DEFAULT_SUBJECT[origin.source]);
  const [message, setMessage] = useState(
    stay
      ? `I'd like to request ${stay.propertyName} from ${stay.checkIn} to ${stay.checkOut}.`
      : "",
  );
  const [guests, setGuests] = useState<number>(stay?.guests ?? 1);
  const [state, setState] = useState<FormState>("idle");
  const [errorMsg, setErrorMsg] = useState("");

  const canSubmit = name.trim() && email.trim() && message.trim().length >= 10;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit || state === "sending") return;

    setState("sending");
    setErrorMsg("");

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          email: email.trim(),
          subject,
          message: message.trim(),
          // How the visitor reached this form, from the link they followed —
          // never from the subject they picked.
          source: origin.source,
          // Additive: absent on every ordinary enquiry, so nothing about the
          // existing submission shape changes.
          ...(stay ? { stay: { ...stay, guests } } : {}),
        }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        throw new Error(data.error || "Something went wrong.");
      }

      setState("success");
    } catch (err) {
      setState("error");
      setErrorMsg(err instanceof Error ? err.message : "Failed to send message. Please try again.");
    }
  }

  return (
    <main className={styles.page}>
      {/* ── NAV ───────────────────────────── */}
      <nav className={styles.nav}>
        <Link href="/" className={styles.navLogo}>
          <ArrowLeft size={14} />
          NUBNB
        </Link>
        <div className={styles.navLinks}>
          <Link href="/about" className={styles.navLink}>
            About
          </Link>
          <Link href="/" className={styles.navCta}>
            Browse Stays
          </Link>
        </div>
      </nav>

      {state === "success" ? (
        /* ── SUCCESS ─────────────────────── */
        <div className={styles.success}>
          <div className={styles.successIcon}>
            <CheckCircle size={28} strokeWidth={1.6} />
          </div>
          <h1 className={styles.successTitle}>Message sent.</h1>
          <p className={styles.successSub}>
            We&rsquo;ll be in touch within 24 hours.
          </p>
          <Link href="/" className={styles.backLink}>
            Back to browsing <ArrowRight size={14} />
          </Link>
        </div>
      ) : (
        /* ── FORM ────────────────────────── */
        <div className={styles.wrapper}>
          <header className={styles.header}>
            <p className={styles.eyebrow}>{stay ? "Request dates" : "Contact"}</p>
            <h1 className={styles.headline}>{stay ? "Request these dates." : "Get in touch."}</h1>
            <p className={styles.subline}>
              {stay
                ? "Confirm your details and we\u2019ll come back to you about this stay."
                : "Questions, partnerships, or booking help, we\u2019re here for it."}
            </p>
          </header>

          {stay && (
            <section className={styles.stayCard} aria-labelledby="stay-heading">
              <h2 id="stay-heading" className={styles.stayHeading}>Your request</h2>
              <p className={styles.stayProperty}>{stay.propertyName}</p>
              <dl className={styles.stayMeta}>
                <div className={styles.stayMetaItem}>
                  <dt><CalendarDays size={14} aria-hidden="true" /> Check-in</dt>
                  <dd>{prettyDate(stay.checkIn)}</dd>
                </div>
                <div className={styles.stayMetaItem}>
                  <dt><CalendarDays size={14} aria-hidden="true" /> Check-out</dt>
                  <dd>{prettyDate(stay.checkOut)}</dd>
                </div>
              </dl>
              <div className={styles.fieldGroup}>
                <label htmlFor="contact-guests" className={styles.label}>
                  <Users size={14} aria-hidden="true" /> Guests
                </label>
                <input
                  id="contact-guests"
                  className={styles.input}
                  type="number"
                  min={1}
                  max={50}
                  value={guests}
                  onChange={(e) => setGuests(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
                />
              </div>
            </section>
          )}

          <form className={styles.form} onSubmit={handleSubmit} noValidate>
            <div className={styles.fieldGroup}>
              <label htmlFor="contact-name" className={styles.label}>Name</label>
              <input
                id="contact-name"
                className={styles.input}
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="contact-email" className={styles.label}>Email</label>
              <input
                id="contact-email"
                className={styles.input}
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="contact-subject" className={styles.label}>Subject</label>
              <select
                id="contact-subject"
                className={styles.select}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              >
                {INQUIRY_SUBJECTS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>

            <div className={styles.fieldGroup}>
              <label htmlFor="contact-message" className={styles.label}>Message</label>
              <textarea
                id="contact-message"
                className={styles.textarea}
                placeholder="Tell us how we can help..."
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={5}
              />
            </div>

            {state === "error" && (
              <div className={styles.error}>{errorMsg}</div>
            )}

            <button
              type="submit"
              className={styles.submit}
              disabled={!canSubmit || state === "sending"}
            >
              {state === "sending" ? (
                <>
                  <span className={styles.spinner} />
                  Sending…
                </>
              ) : (
                <>
                  <Send size={16} />
                  Send Message
                </>
              )}
            </button>
          </form>

          <footer className={styles.footer}>
            © {new Date().getFullYear()} NuBnb Suites
          </footer>
        </div>
      )}
    </main>
  );
}
