// Overtime classification.
//
// A granted OT window is split into the four labor categories from two
// independent dimensions of the scheduled date/time:
//   • rest day?               → rest-day premium
//   • night hours 22:00–06:00 → night differential
// yielding OT, NDOT (night), RDOT (rest day), and RDNDOT (rest day + night).
//
// The night window (22:00–06:00) is evaluated in PHILIPPINE time regardless of
// the server's timezone — OT times are Manila wall-clock, so night must be too,
// or the same OT window would classify differently on a UTC vs Manila server.

const HOUR = 3_600_000;
const DAY = 86_400_000;
const MANILA_OFFSET = 8 * HOUR; // PH is UTC+8, no DST
const NIGHT_START = 22; // 10:00 PM
const NIGHT_END = 6; //    6:00 AM

/** Hours of [a, b) that fall inside the nightly 22:00–06:00 window (Manila). */
export function nightOverlapHours(a: Date, b: Date): number {
  // Shift instants into a Manila-local frame, then apply fixed daily windows.
  const aM = a.getTime() + MANILA_OFFSET;
  const bM = b.getTime() + MANILA_OFFSET;
  if (bM <= aM) return 0;
  let total = 0;
  let day = Math.floor(aM / DAY) * DAY - DAY; // include the prior evening's window
  let guard = 0;
  while (day < bM && guard++ < 400) {
    const winStart = day + NIGHT_START * HOUR;
    const winEnd = day + DAY + NIGHT_END * HOUR; // wraps to next-day 06:00
    const ov = Math.min(bM, winEnd) - Math.max(aM, winStart);
    if (ov > 0) total += ov / HOUR;
    day += DAY;
  }
  return total;
}

export interface OtBreakdown {
  ot: number;     // ordinary overtime (working day, daytime)
  ndot: number;   // night-differential OT (working day, night)
  rdot: number;   // rest-day OT (rest day, daytime)
  rdndot: number; // rest-day night-differential OT (rest day, night)
}

export const EMPTY_OT: OtBreakdown = { ot: 0, ndot: 0, rdot: 0, rdndot: 0 };

/** Split a granted OT window into the four categories, in hours. */
export function classifyOvertime(start: Date | null, end: Date | null, isRestDay: boolean): OtBreakdown {
  if (!start || !end || end.getTime() <= start.getTime()) return { ...EMPTY_OT };
  const total = (end.getTime() - start.getTime()) / HOUR;
  const night = Math.min(total, nightOverlapHours(start, end));
  const day = Math.max(0, total - night);
  return isRestDay
    ? { ...EMPTY_OT, rdot: day, rdndot: night }
    : { ...EMPTY_OT, ot: day, ndot: night };
}

const CODES: [keyof OtBreakdown, string][] = [
  ['ot', 'OT'], ['ndot', 'NDOT'], ['rdot', 'RDOT'], ['rdndot', 'RDNDOT'],
];
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Compact human label: single category → "RDOT"; mixed → "OT 2h · NDOT 1h". */
export function otClassLabel(b: OtBreakdown): string {
  const parts = CODES.filter(([k]) => b[k] > 0.0001);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0][1];
  return parts.map(([k, code]) => `${code} ${r1(b[k])}h`).join(' · ');
}
