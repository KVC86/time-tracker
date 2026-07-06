import { classifyOvertime, otClassLabel } from '../src/common/overtime';

// Pure unit tests (no DB). Dates are built with the local-time constructor so
// the night window (22:00–06:00 local) lines up regardless of the runner's tz.
const at = (h: number, m = 0, day = 15) => new Date(2026, 7, day, h, m, 0); // Aug 2026

describe('classifyOvertime — OT / NDOT / RDOT / RDNDOT', () => {
  it('working day, daytime → OT', () => {
    const c = classifyOvertime(at(10), at(12), false);
    expect(c).toEqual({ ot: 2, ndot: 0, rdot: 0, rdndot: 0 });
    expect(otClassLabel(c)).toBe('OT');
  });

  it('working day, night hours → NDOT', () => {
    const c = classifyOvertime(at(22), at(24), false); // 22:00–00:00
    expect(c.ndot).toBeCloseTo(2, 5);
    expect(c.ot).toBe(0);
    expect(otClassLabel(c)).toBe('NDOT');
  });

  it('rest day, daytime → RDOT', () => {
    const c = classifyOvertime(at(10), at(12), true);
    expect(c).toEqual({ ot: 0, ndot: 0, rdot: 2, rdndot: 0 });
    expect(otClassLabel(c)).toBe('RDOT');
  });

  it('rest day, night hours → RDNDOT', () => {
    const c = classifyOvertime(at(23), at(25), true); // 23:00–01:00 next day
    expect(c.rdndot).toBeCloseTo(2, 5);
    expect(otClassLabel(c)).toBe('RDNDOT');
  });

  it('window straddling 22:00 splits into a mix', () => {
    const c = classifyOvertime(at(20), at(23), false); // 2h day + 1h night
    expect(c.ot).toBeCloseTo(2, 5);
    expect(c.ndot).toBeCloseTo(1, 5);
    expect(otClassLabel(c)).toBe('OT 2h · NDOT 1h');
  });

  it('empty / inverted windows classify as nothing', () => {
    expect(otClassLabel(classifyOvertime(null, null, true))).toBe('');
    expect(otClassLabel(classifyOvertime(at(12), at(10), false))).toBe('');
  });
});
