import { z } from 'zod';
import nodemailer from 'nodemailer';
import { getAdminDb } from '@/app/lib/firebase/admin';
import { createRateLimiter } from '@/app/lib/api/rate-limit';
import { apiSuccess, apiError, apiRateLimited, apiValidationError } from '@/app/lib/api/safe-response';

// 5 contact submissions per 15 minutes per IP
const limiter = createRateLimiter({ windowMs: 15 * 60_000, maxRequests: 5, prefix: 'contact' });

const ContactSchema = z.object({
  name: z.string().min(1, 'Name is required').max(120),
  email: z.string().email('Invalid email address').max(254),
  subject: z.enum([
    "I'm looking to book",
    'I want to list my property',
    'General enquiry',
  ]),
  message: z.string().min(10, 'Message must be at least 10 characters').max(5000),
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

  const { name, email, subject, message } = result.data;

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
    });

    // ── 2. Send email notification to team Gmail ──────────
    const transporter = getTransporter();
    const notifyEmail = process.env.CONTACT_NOTIFY_EMAIL || process.env.GMAIL_USER;

    if (transporter && notifyEmail) {
      await transporter.sendMail({
        from: `"NuBnb Suites" <${process.env.GMAIL_USER}>`,
        to: notifyEmail,
        replyTo: email,
        subject: `[NuBnb Contact] ${subject} | ${name}`,
        text: [
          `New contact form submission from nubnb.ca`,
          ``,
          `Name:    ${name}`,
          `Email:   ${email}`,
          `Subject: ${subject}`,
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
