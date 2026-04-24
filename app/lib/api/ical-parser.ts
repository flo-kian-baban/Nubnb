/**
 * Shared iCal VEVENT parser.
 * Extracts booked date ranges from raw iCalendar text.
 *
 * Supports:
 *   - Basic VEVENT blocks with DTSTART/DTEND
 *   - RRULE recurrence rules (DAILY, WEEKLY, MONTHLY, YEARLY)
 *   - EXDATE exception dates (removed from recurring series)
 *
 * Uses a line-by-line parser instead of a library to avoid
 * Turbopack/bundler compatibility issues.
 */

export interface IcalEvent {
  start: Date;
  end: Date;
}

/** Maximum number of recurring instances to expand per event */
const MAX_OCCURRENCES = 365;
/** Default expansion horizon: 1 year from now */
const EXPANSION_HORIZON_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Parse a date value from an iCal line.
 * Handles:
 *   - DTSTART;VALUE=DATE:20240902
 *   - DTSTART:20240902T120000Z
 *   - DTSTART;TZID=America/New_York:20240902T120000
 */
function parseIcalDate(line: string): Date | null {
  const match = line.match(/:(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2}))?/);
  if (!match) return null;

  const [, y, m, d, hh, mm, ss] = match;
  if (hh) {
    return new Date(Date.UTC(+y, +m - 1, +d, +hh, +mm, +ss));
  }
  return new Date(`${y}-${m}-${d}T00:00:00Z`);
}

/**
 * Parse EXDATE values from an iCal line.
 * EXDATE can be a single date or comma-separated list.
 *   - EXDATE:20240902
 *   - EXDATE;VALUE=DATE:20240902,20240910
 *   - EXDATE:20240902T120000Z
 */
function parseExDates(line: string): Set<string> {
  const dates = new Set<string>();
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return dates;

  const value = line.substring(colonIdx + 1);
  for (const part of value.split(',')) {
    const trimmed = part.trim();
    const match = trimmed.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) {
      dates.add(`${match[1]}-${match[2]}-${match[3]}`);
    }
  }
  return dates;
}

interface RRule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: Date;
}

/**
 * Parse an RRULE line into a structured object.
 * Example: RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=10
 */
function parseRRule(line: string): RRule | null {
  const colonIdx = line.indexOf(':');
  if (colonIdx === -1) return null;

  const parts = line.substring(colonIdx + 1).split(';');
  const map = new Map<string, string>();
  for (const part of parts) {
    const [key, val] = part.split('=');
    if (key && val) map.set(key.toUpperCase(), val);
  }

  const freq = map.get('FREQ') as RRule['freq'] | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) {
    return null;
  }

  const rule: RRule = {
    freq,
    interval: parseInt(map.get('INTERVAL') || '1', 10) || 1,
  };

  const count = map.get('COUNT');
  if (count) rule.count = parseInt(count, 10);

  const until = map.get('UNTIL');
  if (until) {
    const match = until.match(/^(\d{4})(\d{2})(\d{2})/);
    if (match) {
      rule.until = new Date(`${match[1]}-${match[2]}-${match[3]}T23:59:59Z`);
    }
  }

  return rule;
}

/** Advance a Date by the RRULE frequency and interval */
function advanceDate(date: Date, freq: RRule['freq'], interval: number): Date {
  const next = new Date(date);
  switch (freq) {
    case 'DAILY':
      next.setUTCDate(next.getUTCDate() + interval);
      break;
    case 'WEEKLY':
      next.setUTCDate(next.getUTCDate() + 7 * interval);
      break;
    case 'MONTHLY':
      next.setUTCMonth(next.getUTCMonth() + interval);
      break;
    case 'YEARLY':
      next.setUTCFullYear(next.getUTCFullYear() + interval);
      break;
  }
  return next;
}

/** Format a Date as YYYY-MM-DD for EXDATE comparison */
function toDateKey(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Parse raw iCalendar data and return an array of events with start/end dates.
 *
 * Recurring events (RRULE) are expanded into individual instances.
 * EXDATE entries are excluded from the expansion.
 */
export function parseIcalEvents(icalData: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  const lines = icalData.split(/\r?\n/);

  // Handle line folding (continuation lines start with a space or tab)
  const unfoldedLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      if (unfoldedLines.length > 0) {
        unfoldedLines[unfoldedLines.length - 1] += line.substring(1);
      }
    } else {
      unfoldedLines.push(line);
    }
  }

  let inEvent = false;
  let eventStart: Date | null = null;
  let eventEnd: Date | null = null;
  let rrule: RRule | null = null;
  let exDates = new Set<string>();

  for (const line of unfoldedLines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      eventStart = null;
      eventEnd = null;
      rrule = null;
      exDates = new Set<string>();
    } else if (line.startsWith('END:VEVENT')) {
      inEvent = false;

      if (eventStart && eventEnd && eventStart < eventEnd) {
        const durationMs = eventEnd.getTime() - eventStart.getTime();

        if (rrule) {
          // Expand recurring event into individual instances
          const horizon = new Date(Date.now() + EXPANSION_HORIZON_MS);
          let occurrenceStart = new Date(eventStart);
          let count = 0;

          while (count < MAX_OCCURRENCES) {
            // Check bounds
            if (rrule.until && occurrenceStart > rrule.until) break;
            if (occurrenceStart > horizon) break;
            if (rrule.count !== undefined && count >= rrule.count) break;

            const occurrenceEnd = new Date(occurrenceStart.getTime() + durationMs);
            const dateKey = toDateKey(occurrenceStart);

            // Only add if not in EXDATE exclusion list
            if (!exDates.has(dateKey)) {
              events.push({ start: new Date(occurrenceStart), end: occurrenceEnd });
            }

            occurrenceStart = advanceDate(occurrenceStart, rrule.freq, rrule.interval);
            count++;
          }
        } else {
          // Non-recurring — single event
          events.push({ start: eventStart, end: eventEnd });
        }
      }
    } else if (inEvent) {
      if (line.startsWith('DTSTART')) {
        eventStart = parseIcalDate(line);
      } else if (line.startsWith('DTEND')) {
        eventEnd = parseIcalDate(line);
      } else if (line.startsWith('RRULE')) {
        rrule = parseRRule(line);
      } else if (line.startsWith('EXDATE')) {
        const parsed = parseExDates(line);
        for (const d of parsed) exDates.add(d);
      }
    }
  }

  return events;
}
