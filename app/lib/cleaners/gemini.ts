/**
 * One call to Gemini: read a receipt photo into lines (dispatch 20).
 *
 * ── Key ──
 * GEMINI_API_KEY is read here, inside the request, and goes out in a request
 * header to Google. It is never logged, never returned and never bundled:
 * this module is imported only by the read route, which is server code. A
 * server without the key answers 503 on that route, and the phone falls
 * back to typing (RECEIPT_READER_NOT_CONFIGURED). GEMINI_API_BASE, when set,
 * replaces the Google host: verification points it at a stub that answers
 * slowly or not at all.
 *
 * ── What is asked ──
 * The same instruction, schema and settings the measurement of 2026-09-30
 * used (see CLEANER-COSTS-DESIGN.md §12), on the model Kian chose,
 * gemini-3.8-flash, with thinking pinned low: at its default level the
 * model spent 650–1,100 thinking tokens and 4–5 seconds a receipt. The
 * answer is structured JSON in the ReadingOutput shape.
 *
 * ── Failure ──
 * Nothing thrown leaves this module. A timeout, a refused request, an
 * unparsable answer, a blocked one: each comes back as `failed` with a
 * reason word, and the phone keeps its photo and its form. Only status
 * codes and reasons are logged.
 */

import {
  READING_LIMITS,
  RECEIPT_READER_MODEL,
  RECEIPT_READER_THINKING,
  readReadingOutput,
  type ReadingOutput,
  type ReadingRecord,
  type ReceiptType,
} from './model';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com';

/** A key is letters, digits and a few separators; anything else is a paste error, refused without being logged. */
const KEY_FORMAT = /^[A-Za-z0-9_.-]{20,200}$/;

export type GeminiSecrets = { kind: 'ok'; apiKey: string; base: string } | { kind: 'not-configured' };

/** The key and the host, or `not-configured`. Call it inside a handler, never at module scope. */
export function getGeminiSecrets(): GeminiSecrets {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || !KEY_FORMAT.test(apiKey)) {
    console.error(`[read-receipt] GEMINI_API_KEY is ${apiKey ? 'not in the expected form' : 'not set'}`);
    return { kind: 'not-configured' };
  }
  const base = (process.env.GEMINI_API_BASE ?? '').trim().replace(/\/+$/, '');
  return { kind: 'ok', apiKey, base: /^https?:\/\/[^\s/]+$/.test(base) ? base : DEFAULT_BASE };
}

// ─── The request ───────────────────────────────────────────────

const SYSTEM_INSTRUCTION = `You read photographs of paper receipts from Canadian stores so the lines can be filled into a bookkeeping form. Return JSON only.

Transcribe every printed line that carries its own amount, from top to bottom, exactly as printed:
- "name": the item text as printed (keep the store's abbreviations; leave out product codes, PLU numbers and barcodes).
- "amount": the amount printed at the end of THAT line, as a string with two decimals, e.g. "7.98". If the line shows a quantity and a unit price and then a line total (e.g. "2 @ 3.99 7.98"), the amount is the line total (7.98) and "quantity" is 2. Otherwise quantity is null.
- Discounts, coupons, instant savings, price adjustments and returns are their own lines with a NEGATIVE amount.
- Taxes (GST, HST, PST, QST, TPS, TVQ) are their own lines with kind "tax". Bottle deposits, eco fees, bag fees are their own lines with kind "fee".
- Do NOT put the subtotal, the total, tender, change, cash back, card or payment lines in "lines".
- Never invent a line. If a name cannot be read, use "?" for the name. If an amount cannot be read, use null.
- "total" is the grand total as printed, or null. "subtotal" likewise.
- "store": the merchant name as printed, or null. "purchasedOn": the purchase date printed on the receipt as YYYY-MM-DD, or null if not printed or unreadable. Currency is CAD.
- "unreadable": true only if nothing on the receipt can be read. "notes": at most one short sentence about anything uncertain, else null.`;

const USER_TEXT = 'Read this receipt.';

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    store: { type: 'string', nullable: true },
    purchasedOn: { type: 'string', nullable: true },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          quantity: { type: 'number', nullable: true },
          amount: { type: 'string', nullable: true },
          kind: { type: 'string', enum: ['item', 'discount', 'tax', 'fee'] },
        },
        required: ['name', 'quantity', 'amount', 'kind'],
      },
    },
    subtotal: { type: 'string', nullable: true },
    total: { type: 'string', nullable: true },
    unreadable: { type: 'boolean' },
    notes: { type: 'string', nullable: true },
  },
  required: ['store', 'purchasedOn', 'lines', 'subtotal', 'total', 'unreadable', 'notes'],
};

/** The fields of a ReadingRecord that the call itself decides. */
export type GeminiOutcome = Pick<ReadingRecord, 'modelVersion' | 'ms' | 'status' | 'reason' | 'usage' | 'output' | 'rawText'>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function usageOf(body: Record<string, unknown>): ReadingRecord['usage'] {
  const usage = isRecord(body.usageMetadata) ? body.usageMetadata : null;
  if (!usage) return null;
  const n = (value: unknown) => (typeof value === 'number' ? value : 0);
  return {
    promptTokens: n(usage.promptTokenCount),
    outputTokens: n(usage.candidatesTokenCount),
    thoughtsTokens: n(usage.thoughtsTokenCount),
  };
}

function failed(ms: number, reason: string, extra: Partial<GeminiOutcome> = {}): GeminiOutcome {
  return { modelVersion: null, ms, status: 'failed', reason, usage: null, output: null, rawText: null, ...extra };
}

/**
 * Read one receipt. Resolves always; never throws. `ms` is the wall-clock
 * time of the call, whatever its outcome.
 */
export async function readReceiptWithGemini(
  secrets: Extract<GeminiSecrets, { kind: 'ok' }>,
  bytes: Buffer,
  contentType: ReceiptType,
): Promise<GeminiOutcome> {
  const url = `${secrets.base}/v1beta/models/${RECEIPT_READER_MODEL}:generateContent`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
    contents: [
      {
        role: 'user',
        parts: [{ inlineData: { mimeType: contentType, data: bytes.toString('base64') } }, { text: USER_TEXT }],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: READING_LIMITS.MAX_OUTPUT_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      thinkingConfig: { thinkingLevel: RECEIPT_READER_THINKING },
    },
  };

  const started = Date.now();
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': secrets.apiKey },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(READING_LIMITS.TIMEOUT_MS),
      cache: 'no-store',
    });
    text = await response.text();
  } catch (err) {
    const ms = Date.now() - started;
    const name = (err as { name?: unknown } | null)?.name;
    const reason = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'network';
    console.error(`[read-receipt] ${reason} after ${ms} ms`);
    return failed(ms, reason);
  }
  const ms = Date.now() - started;

  if (!response.ok) {
    console.error(`[read-receipt] http ${response.status} after ${ms} ms`);
    return failed(ms, `http_${response.status}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.error(`[read-receipt] answer is not JSON after ${ms} ms`);
    return failed(ms, 'unparsable');
  }
  if (!isRecord(parsed)) return failed(ms, 'unparsable');

  const modelVersion = typeof parsed.modelVersion === 'string' ? parsed.modelVersion : null;
  const usage = usageOf(parsed);
  const candidate = Array.isArray(parsed.candidates) && isRecord(parsed.candidates[0]) ? parsed.candidates[0] : null;
  const finish = typeof candidate?.finishReason === 'string' ? candidate.finishReason : null;
  const content = candidate && isRecord(candidate.content) && Array.isArray(candidate.content.parts) ? candidate.content.parts : [];
  const answer = content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).join('');

  if (!candidate || finish === 'SAFETY' || finish === 'PROHIBITED_CONTENT' || finish === 'BLOCKLIST') {
    console.error(`[read-receipt] blocked (${finish ?? 'no candidate'}) after ${ms} ms`);
    return failed(ms, 'blocked', { modelVersion, usage });
  }
  if (answer === '') {
    console.error(`[read-receipt] no output (${finish ?? 'no finish reason'}) after ${ms} ms`);
    return failed(ms, 'no_output', { modelVersion, usage });
  }

  let output: ReadingOutput | null = null;
  try {
    output = readReadingOutput(JSON.parse(answer));
  } catch {
    output = null;
  }
  if (!output) {
    console.error(`[read-receipt] output not in the asked shape (${finish ?? '?'}) after ${ms} ms`);
    return failed(ms, 'unparsable', { modelVersion, usage, rawText: answer.slice(0, 20_000) });
  }

  console.log(`[read-receipt] ok: ${output.lines.length} lines in ${ms} ms (${modelVersion ?? RECEIPT_READER_MODEL})`);
  return { modelVersion, ms, status: 'ok', reason: null, usage, output, rawText: null };
}
