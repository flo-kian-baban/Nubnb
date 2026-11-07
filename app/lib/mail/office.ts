/**
 * Email to the office, through the one transport Nubnb has: the contact form's Gmail SMTP transporter (an App
 * Password; GMAIL_USER, GMAIL_APP_PASSWORD), sent to CONTACT_NOTIFY_EMAIL or, failing that, GMAIL_USER. Used by the
 * contact form (app/api/contact/route.ts) and by the sign-in doors' daily budget (Kian's ruling of 2026-11-06: at each
 * threshold, one email to the office through the existing contact-form transport). Server-only.
 *
 * Never throws: every outcome comes back for the caller's record. The transport is bounded, so a mail server that
 * stops answering is recorded as a failure instead of holding the request until the platform kills it.
 */

import nodemailer, { type Transporter } from 'nodemailer';

/** What became of an email: the SMTP server's acceptance line, or why it was not sent. */
export type MailOutcome = { status: 'sent'; at: string; response: string } | { status: 'failed'; at: string; error: string };

/** The Gmail SMTP transporter, or null when the credentials are not set. */
export function officeTransporter(): Transporter | null {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Where the office's mail goes: CONTACT_NOTIFY_EMAIL, else the sending account itself. */
export function officeAddress(): string | null {
  return process.env.CONTACT_NOTIFY_EMAIL || process.env.GMAIL_USER || null;
}

export function describeSendError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return `${typeof code === 'string' ? `${code}: ` : ''}${message}`.replace(/\s+/g, ' ').slice(0, 300);
}

/** Send one email to the office. `replyTo`: the contact form's visitor, so a reply reaches them. Never throws. */
export async function mailOffice(mail: { subject: string; text: string; replyTo?: string }): Promise<MailOutcome> {
  const failed = (error: string): MailOutcome => ({ status: 'failed', at: new Date().toISOString(), error });
  const transporter = officeTransporter();
  const to = officeAddress();
  if (!transporter || !to) return failed('Email is not configured on the server: GMAIL_USER and GMAIL_APP_PASSWORD must both be set.');
  try {
    const info = await transporter.sendMail({
      from: `"NuBnb Suites" <${process.env.GMAIL_USER}>`,
      to,
      ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
      subject: mail.subject,
      text: mail.text,
    });
    const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
    if (rejected > 0) return failed(`The mail server refused ${rejected} recipient(s).`);
    // The SMTP server's own acceptance line, e.g. "250 2.0.0 OK … gsmtp": proof it took the message, as far as a sender can see.
    return { status: 'sent', at: new Date().toISOString(), response: String(info.response ?? '').slice(0, 300) };
  } catch (err) {
    console.error('[mail] the email to the office failed:', describeSendError(err));
    return failed(describeSendError(err));
  }
}
