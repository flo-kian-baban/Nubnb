/**
 * The iCal parser lives in app/lib/availability/ical.ts since 2026-09-30,
 * beside the availability refresh that runs it. This path stays for the
 * public availability routes, which read only `start` and `end`.
 */
export { parseIcalEvents, type IcalEvent } from '../availability/ical';
