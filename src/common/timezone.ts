// All business time in this system is Philippine Time (Asia/Manila),
// regardless of where the server runs. Every place that turns a wall-clock
// string into a Date, or a Date into a calendar day / display label, must go
// through these helpers — never through zone-less `new Date(...)` parsing,
// which silently uses the server's local timezone (the kristhian.asia box
// runs UTC, which shifted every schedule by 8 hours).
//
// The Philippines has no daylight-saving time and a fixed +08:00 offset, so
// the conversion is a constant shift — no timezone database required.

export const BUSINESS_TZ = 'Asia/Manila';
export const BUSINESS_UTC_OFFSET = '+08:00';
const OFFSET_MS = 8 * 3_600_000;

/** "YYYY-MM-DD" + "HH:mm" as Manila wall-clock → absolute instant. */
export function manilaDateTime(dateISO: string, timeHHmm: string): Date {
  return new Date(`${dateISO}T${timeHHmm}:00${BUSINESS_UTC_OFFSET}`);
}

/** The Manila calendar date ("YYYY-MM-DD") at a given instant. */
export function manilaDateISO(at: Date = new Date()): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * UTC-midnight Date for the Manila calendar date at a given instant — the
 * storage convention for date-only columns like Schedule.workDate.
 */
export function manilaWorkDate(at: Date = new Date()): Date {
  return new Date(`${manilaDateISO(at)}T00:00:00Z`);
}

/** The instant Manila's calendar day started (00:00 Manila) for a given time. */
export function manilaStartOfDay(at: Date = new Date()): Date {
  return new Date(`${manilaDateISO(at)}T00:00:00${BUSINESS_UTC_OFFSET}`);
}

/** "4:00 PM"-style label of an instant, in Manila time. */
export function manilaTimeLabel(d: Date): string {
  return d.toLocaleTimeString('en-PH', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: BUSINESS_TZ,
  });
}
