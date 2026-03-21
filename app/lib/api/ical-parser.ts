/**
 * Shared iCal VEVENT parser.
 * Extracts booked date ranges from raw iCalendar text.
 *
 * Uses a simple line-by-line parser instead of a library to avoid
 * Turbopack/bundler compatibility issues.
 */

export interface IcalEvent {
  start: Date;
  end: Date;
}

/**
 * Parse raw iCalendar data and return an array of events with start/end dates.
 *
 * Handles formats:
 *   - DTSTART;VALUE=DATE:20240902
 *   - DTSTART:20240902T120000Z
 */
export function parseIcalEvents(icalData: string): IcalEvent[] {
  const events: IcalEvent[] = [];
  const lines = icalData.split(/\r?\n/);

  let inEvent = false;
  let eventStart: Date | null = null;
  let eventEnd: Date | null = null;

  for (const line of lines) {
    if (line.startsWith('BEGIN:VEVENT')) {
      inEvent = true;
      eventStart = null;
      eventEnd = null;
    } else if (line.startsWith('END:VEVENT')) {
      inEvent = false;
      if (eventStart && eventEnd && eventStart < eventEnd) {
        events.push({ start: eventStart, end: eventEnd });
      }
    } else if (inEvent) {
      if (line.startsWith('DTSTART')) {
        const match = line.match(/^DTSTART.*?:(\d{4})(\d{2})(\d{2})/);
        if (match) {
          eventStart = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
        }
      } else if (line.startsWith('DTEND')) {
        const match = line.match(/^DTEND.*?:(\d{4})(\d{2})(\d{2})/);
        if (match) {
          eventEnd = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
        }
      }
    }
  }

  return events;
}
