import { NextResponse } from 'next/server';
import { startOfDay, endOfDay, parseISO } from 'date-fns';

export async function POST(request: Request) {
  try {
    const { icalUrl, startDate, endDate } = await request.json();

    if (!icalUrl || !startDate || !endDate) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    // Fetch the raw iCal text
    const response = await fetch(icalUrl);
    if (!response.ok) throw new Error('Failed to fetch iCal feed');
    
    const icalData = await response.text();
    
    // Parse the requested user dates
    const requestedStart = startOfDay(parseISO(startDate));
    const requestedEnd = endOfDay(parseISO(endDate));
    
    let isAvailable = true;

    // Simple robust parsing for VEVENTs to avoid node library turbopack incompatibilities
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
        if (eventStart && eventEnd) {
          // Check for temporal overlap
          // Overlap happens if: requestedStart < eventEnd AND requestedEnd > eventStart
          if (requestedStart < eventEnd && requestedEnd > eventStart) {
            isAvailable = false;
            break; // Stop checking once we find a conflict
          }
        }
      } else if (inEvent) {
        if (line.startsWith('DTSTART')) {
          // Format expected: DTSTART;VALUE=DATE:20240902 or DTSTART:20240902T120000Z
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

    return NextResponse.json({ available: isAvailable });

  } catch (error) {
    console.error('Error checking iCal availability:', error);
    return NextResponse.json({ error: 'Failed to verify availability against the calendar' }, { status: 500 });
  }
}
