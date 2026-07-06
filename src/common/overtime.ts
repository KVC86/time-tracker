// Overtime classification.
//
// A granted OT window is split into the four labor categories from two
// independent dimensions of the scheduled date/time:
//   • rest day?               → rest-day premium
//   • night hours 22:00–06:00 → night differential
// yielding OT, NDOT (night), RDOT (rest day), and RDNDOT (rest day + night).
//
// The night window is computed in the server's local time — identical to the
// payroll night-differential calc — so classification labels and pay always
// agree. (Both share the latent assumption that the server runs Manila time.)

const HOUR = 3_600_000;
const NIGHT_START = 22; // 10:00 PM
const NIGHT_END = 6; //    6:00 AM

/** Hours of [a, b) that fall inside the nightly 22:00–06:00 window (local). */
export function nightOverlapHours(a: Date, b: Date): number {
  let total = 0;
  const day = new Date(a);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1); // a night window can start the previous evening
  let guard = 0;
  while (day.getTime() < b.getTime() && guard++ < 400) {
    const winStart = new Date(day); winStart.setHours(NIGHT_START, 0, 0, 0);
    const winEnd = new Date(day); winEnd.setHours(NIGHT_END, 0, 0, 0);
    winEnd.setDate(winEnd.getDate() + 1); // wraps past midnight
    const ov = Math.min(b.getTime(), winEnd.getTime()) - Math.max(a.getTime(), winStart.getTime());
    if (ov > 0) total += ov / HOUR;
    day.setDate(day.getDate() + 1);
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
