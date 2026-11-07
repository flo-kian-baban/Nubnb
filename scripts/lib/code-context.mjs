/**
 * Where a four-digit run sits, for the commit-tree scan (scripts/scan-tree-for-codes.mjs). Kian's ruling of
 * 2026-11-06 (the security round, item 3):
 *
 *   code-like, which the scan BLOCKS — a line mentioning codes or PINs, an easy-code list, anything under tests/, a
 *   .md file, the commit message, and anything this file cannot classify;
 *
 *   incidental, which the scan only REPORTS — a hex colour, a date or a time, the inside of an ID or a hash. The
 *   advice for a reported hit is to change the code, never to rewrite the file: a blind rewrite of a colour is itself
 *   a signpost in the public diff, and a guesser cannot tell such digits from the other few hundred four-digit strings
 *   in the repository.
 *
 * There is no list of codes never given out (Kian's ruling of 2026-11-07): the daily wrong-code budget and its email
 * are the protection, and this classifier serves the scan alone. Nothing here prints, reads the environment or
 * touches a file: the scan hands it lines and gets a verdict.
 */

/** A standalone four-digit run: bounded by non-digits (the character before and after may be anything but a digit). */
export const FOUR_DIGITS = /(?<![0-9])[0-9]{4}(?![0-9])/g;

/** A line about codes or PINs: any of these words on it makes every four-digit run on it code-like. */
export const CODE_WORDS = /\b(codes?|PINs?|pins?|passcodes?|cleaner_codes|admin_pins|ADMIN_PIN|four[ -]digits?|4[ -]digits?|straight run|too easy|easy)\b/i;

/** The easy list (app/lib/cleaners/model.ts): four of one digit, the seven ascending runs, the seven descending runs. */
export const isEasyCode = (value) => /^(\d)\1{3}$/.test(value) || '0123456789'.includes(value) || '9876543210'.includes(value);

const MONTH_BEFORE = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s*\d{0,2}(st|nd|rd|th)?,?\s*$/i;
const MONTH_AFTER = /^[,.]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\b/i;

/**
 * The verdict on one standalone four-digit run at `line.slice(start, end)`:
 * `{ kind: 'code-like' | 'incidental', context }`. `path` is the file it is in (null for text that is not a file);
 * `message` true for a commit message.
 */
export function classifyRun(line, start, end, { path = null, message = false } = {}) {
  if (message) return { kind: 'code-like', context: 'the commit message' };
  if (path !== null) {
    if (/(^|\/)tests\//.test(path)) return { kind: 'code-like', context: 'a test' };
    if (/\.md$/i.test(path)) return { kind: 'code-like', context: 'a document' };
  }
  if (CODE_WORDS.test(line)) return { kind: 'code-like', context: 'a line about codes or PINs' };
  const value = line.slice(start, end);
  const before = line.slice(0, start);
  const after = line.slice(end);
  // An easy-code list: this value is an easy code, and another easy code stands on the same line.
  if (isEasyCode(value) && [...line.matchAll(FOUR_DIGITS)].some((m) => m.index !== start && isEasyCode(m[0]))) return { kind: 'code-like', context: 'an easy-code list' };
  // A hex colour: #abc, #abcd, #aabbcc or #aabbccdd around the run.
  const hex = /#([0-9a-fA-F]*)$/.exec(before);
  if (hex) {
    const tail = /^[0-9a-fA-F]*/.exec(after)[0];
    if ([3, 4, 6, 8].includes(hex[1].length + 4 + tail.length)) return { kind: 'incidental', context: 'a hex colour' };
  }
  // The inside of an ID or a hash: the word around the run mixes in an underscore, other digits, or letters on both
  // sides; or letters on one side that are not a number's unit (4812px, 4812ms are numbers, and block); or a
  // hyphenated token with letters in it (a UUID's part).
  const head = /[A-Za-z0-9_]*$/.exec(before)[0];
  const tail = /^[A-Za-z0-9_]*/.exec(after)[0];
  if (head || tail) {
    const word = `${head}${value}${tail}`;
    const unit = /^(px|ms|s|em|rem|vh|vw|vmin|vmax|deg|rad|fr|ch|ex|pt|pc|cm|mm|in|q|x|n|k|m|g|kb|mb|gb|th|st|nd|rd|am|pm|h|hr|hrs|min|d|a|b|c|e|f)$/i;
    const mixed = word.includes('_') || /\d/.test(head) || /\d/.test(tail) || (/[A-Za-z]/.test(head) && /[A-Za-z]/.test(tail));
    const oneSide = (head && !tail && !unit.test(head)) || (tail && !head && !unit.test(tail));
    if (mixed || oneSide) return { kind: 'incidental', context: 'inside an ID or hash' };
  }
  if ((/[0-9a-zA-Z]*[a-zA-Z][0-9a-zA-Z]*-$/.test(before) || /^-[0-9a-zA-Z]*[a-zA-Z][0-9a-zA-Z]*/.test(after)) && /^[0-9a-f]{4}$/.test(value)) return { kind: 'incidental', context: 'inside an ID or hash' };
  // A date: yyyy-mm, yyyy-mm-dd, yyyy/m/d, dd-mm-yyyy, dd.mm.yyyy, "Nov 6, yyyy", "yyyy Nov"; a time zone offset after a clock time.
  if (/^(19|20)\d{2}$/.test(value) && (/^[-/.]\d{1,2}([-/.]\d{1,2})?(?![0-9])/.test(after) || /\d{1,2}[-/.]\d{1,2}[-/.]$/.test(before) || MONTH_BEFORE.test(before) || MONTH_AFTER.test(after))) return { kind: 'incidental', context: 'a date' };
  if (/\d{2}:\d{2}(:\d{2})?(\.\d+)?\s?[+-]$/.test(before) && /^[0-5]\d$/.test(value.slice(2))) return { kind: 'incidental', context: 'a time zone offset' };
  return { kind: 'code-like', context: 'unclassified' };
}

/**
 * Every standalone four-digit run in `text` whose value is in `values`, with its verdict: `[{ value, line, kind,
 * context }]`, `line` 1-based. The caller never prints `value`.
 */
export function findRuns(text, values, where = {}) {
  const wanted = values instanceof Set ? values : new Set(values);
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const m of line.matchAll(FOUR_DIGITS)) {
      if (!wanted.has(m[0])) continue;
      const verdict = classifyRun(line, m.index, m.index + 4, where);
      hits.push({ value: m[0], line: i + 1, kind: verdict.kind, context: verdict.context });
    }
  }
  return hits;
}

/** Whether a buffer is text: no NUL byte in its first 8,000 bytes. */
export const isTextBuffer = (buf) => !buf.subarray(0, 8000).includes(0);
