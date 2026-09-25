import { z } from 'zod';
import nodemailer from 'nodemailer';
import type { DocumentReference } from 'firebase-admin/firestore';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiRateLimited, apiValidationError } from '@/app/lib/api/safe-response';
import { INQUIRY_SOURCES, INQUIRY_SUBJECTS } from '@/app/lib/inquiry';

/**
 * Room for the email's own timeouts (see getTransporter) to run out and be
 * recorded. A lower platform default could kill the function first, and the
 * visitor would see an error for a message that was stored.
 */
export const maxDuration = 30;

// 5 contact submissions per 15 minutes per IP
const limiter = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 5, prefix: 'contact' });

/**
 * A request for specific dates on a specific property, sent by the "Request
 * these dates" button on the detail panel.
 *
 * Stored as fields rather than folded into the message, so the enquiry can
 * later be read, filtered and answered without parsing prose. Optional
 * throughout: an ordinary enquiry carries none of it and is stored exactly as
 * it always was.
 */
const StaySchema = z.object({
  propertyId: z.string().min(1).max(200),
  propertyName: z.string().min(1).max(200),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkIn must be yyyy-mm-dd'),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'checkOut must be yyyy-mm-dd'),
  guests: z.number().int().min(1).max(50),
}).refine((v) => v.checkIn < v.checkOut, {
  message: 'checkOut must be after checkIn',
  path: ['checkOut'],
});

const ContactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  email: z.string().email('Invalid email address').max(254),
  subject: z.enum(INQUIRY_SUBJECTS),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  /**
   * How the visitor reached the form (app/lib/inquiry.ts). Optional only so
   * that a page loaded before this field existed can still submit; such a
   * submission is stored without a source unless it names a property.
   */
  source: z.enum(INQUIRY_SOURCES).optional(),
  stay: StaySchema.optional(),
}).refine((v) => v.source === undefined || (v.source === 'property') === (v.stay !== undefined), {
  message: 'A stay request comes from a property, and only a property arrival carries one',
  path: ['source'],
});

/**
 * What became of the email to the team, recorded on the submission as
 * `notification`. It is written as "pending" with the submission and replaced
 * once the email has been attempted, so a lead whose outcome never landed —
 * the function stopped mid-send — still reads as unconfirmed rather than as
 * nothing at all.
 */
type Notification =
  | { status: 'sent'; at: string; response: string }
  | { status: 'failed'; at: string; error: string };

// Gmail SMTP transporter (uses App Password, free 500 emails/day)
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
    // Bounded, so a mail server that stops answering is recorded as a failed
    // notification instead of holding the request until the platform kills it
    // — which would show the visitor an error for a message that was stored.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

function describeSendError(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  const message = err instanceof Error ? err.message : String(err);
  return `${typeof code === 'string' ? `${code}: ` : ''}${message}`.replace(/\s+/g, ' ').slice(0, 300);
}

/** Email the team. Never throws: every outcome is returned for the record. */
async function notifyTeam(lead: {
  name: string;
  email: string;
  subject: string;
  message: string;
  stay?: z.infer<typeof StaySchema>;
}): Promise<Notification> {
  const { name, email, subject, message, stay } = lead;
  const failed = (error: string): Notification => ({
    status: 'failed',
    at: new Date().toISOString(),
    error,
  });

  const transporter = getTransporter();
  const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || process.env.GMAIL_USER;
  if (!transporter || !notifyEmail) {
    return failed('Email is not configured on the server: GMAIL_USER and GMAIL_APP_PASSWORD must both be set.');
  }

  try {
    const info = await transporter.sendMail({
      from: `"NuBnb Suites" <${process.env.GMAIL_USER}>`,
      to: notifyEmail,
      replyTo: email,
      subject: stay
        ? `[NuBnb Dates Request] ${stay.propertyName} | ${name}`
        : `[NuBnb Contact] ${subject} | ${name}`,
      text: [
        stay
          ? `New dates request from nubnb.ca`
          : `New contact form submission from nubnb.ca`,
        ``,
        `Name:    ${name}`,
        `Email:   ${email}`,
        `Subject: ${subject}`,
        ...(stay
          ? [
              ``,
              `Property:   ${stay.propertyName}`,
              `Property ID:${stay.propertyId}`,
              `Check-in:   ${stay.checkIn}`,
              `Check-out:  ${stay.checkOut}`,
              `Guests:     ${stay.guests}`,
            ]
          : []),
        ``,
        `Message:`,
        message,
        ``,
        `---`,
        `Reply directly to this email to respond to ${name}.`,
      ].join('\n'),
    });

    const rejected = Array.isArray(info.rejected) ? info.rejected.length : 0;
    if (rejected > 0) return failed(`The mail server refused ${rejected} recipient(s).`);

    // The SMTP server's own acceptance line, e.g. "250 2.0.0 OK … gsmtp":
    // proof it took the message, which is as far as a sender can see.
    return {
      status: 'sent',
      at: new Date().toISOString(),
      response: String(info.response ?? '').slice(0, 300),
    };
  } catch (err) {
    console.error('[contact] Notification email failed:', err);
    return failed(describeSendError(err));
  }
}

export async function POST(request: Request) {
  // ── Rate limit ──────────────────────────────────────────
  const limit = await limiter.check(request);
  if (limit.limited) return apiRateLimited(limit.retryAfterMs);

  // ── Parse body ──────────────────────────────────────────
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiError('Invalid JSON body', 400);
  }

  // ── Validate input ──────────────────────────────────────
  const result = ContactSchema.safeParse(body);
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }));
    return apiValidationError(issues);
  }

  const { name, email, subject, message, stay } = result.data;
  // A page from before sources were recorded sends none; a stay request is
  // still known to come from a property.
  const source = result.data.source ?? (stay ? 'property' : undefined);

  // ── 1. Save to Firestore (permanent record) ─────────────
  // The only step that can fail the request: if it fails, nothing was kept
  // and the visitor must be told to try again.
  let submission: DocumentReference;
  try {
    submission = await getAdminDb().collection('contact_submissions').add({
      name,
      email,
      subject,
      message,
      status: 'new',
      createdAt: new Date().toISOString(),
      // Only present on a dates request. Spread rather than written as
      // `stay: undefined`, which the Admin SDK rejects — and which would also
      // add a field to every ordinary submission for no reason.
      ...(stay ? { stay } : {}),
      ...(source ? { source } : {}),
      notification: { status: 'pending' },
    });
  } catch (err) {
    console.error('[contact] Error:', err);
    return apiError('Failed to send message. Please try again.', 500, err);
  }

  // ── 2. Tell the team, and record whether that worked ────
  // From here the message is stored, so the visitor is told it was sent
  // whatever happens to the email. A failed email used to answer 500 here,
  // after the lead had been saved: the visitor saw an error, likely sent it
  // again, and nothing recorded that nobody had been told.
  const notification = await notifyTeam({ name, email, subject, message, stay });
  try {
    await submission.update({ notification });
  } catch (err) {
    // The lead keeps "pending", which the inbox shows as unconfirmed.
    console.error(`[contact] Could not record the notification outcome on ${submission.id}:`, err);
  }

  return apiSuccess({ sent: true });
}
