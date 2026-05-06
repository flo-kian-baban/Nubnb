"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, CheckCircle, Send } from "lucide-react";
import styles from "./page.module.css";

const SUBJECTS = [
  "I'm looking to book",
  "I want to list my property",
  "General enquiry",
] as const;

type FormState = "idle" | "sending" | "success" | "error";

export default function ContactPage() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [subject, setSubject] = useState<string>(SUBJECTS[0]);
  const [message, setMessage] = useState("");
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
        body: JSON.stringify({ name: name.trim(), email: email.trim(), subject, message: message.trim() }),
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
            <p className={styles.eyebrow}>Contact</p>
            <h1 className={styles.headline}>Get in touch.</h1>
            <p className={styles.subline}>
              Questions, partnerships, or booking help, we&rsquo;re here for it.
            </p>
          </header>

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
                {SUBJECTS.map((s) => (
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
