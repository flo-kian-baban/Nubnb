import { z } from 'zod';
import nodemailer from 'nodemailer';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiRateLimited, apiValidationError } from '@/app/lib/api/safe-response';

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
  subject: z.enum([
    "I'm looking to book",
    'I want to list my property',
    'General enquiry',
  ]),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
  stay: StaySchema.optional(),
});

// Gmail SMTP transporter (uses App Password, free 500 emails/day)
function getTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
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

  try {
    // ── 1. Save to Firestore (permanent record) ───────────
    const db = getAdminDb();
    await db.collection('contact_submissions').add({
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
    });

    // ── 2. Send email notification to team Gmail ──────────
    const transporter = getTransporter();
    const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || process.env.GMAIL_USER;

    if (transporter && notifyEmail) {
      await transporter.sendMail({
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
    }

    return apiSuccess({ sent: true });
  } catch (err) {
    console.error('[contact] Error:', err);
    return apiError('Failed to send message. Please try again.', 500, err);
  }
}
