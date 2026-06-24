import { PrismaClient } from '@prisma/client';
import { PayrollController } from '../src/payroll/payroll.controller';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();
const ctrl = new PayrollController(prisma as any);
const amount = (comp: any, gross: number) => (ctrl as any).componentAmount(comp, gross);

afterAll(async () => {
  await prisma.$disconnect();
});

// ── Pure logic: bracket selection + the #3 ordering fix (no DB) ──────────
describe('componentAmount — pay-component computation (#3)', () => {
  it('FIXED returns the flat amount', () => {
    expect(amount({ method: 'FIXED', amount: 1350, percent: null, brackets: null }, 25000)).toBe(1350);
  });

  it('PERCENT_OF_GROSS computes a percentage of gross', () => {
    expect(amount({ method: 'PERCENT_OF_GROSS', amount: null, percent: 4.5, brackets: null }, 20000)).toBe(900);
  });

  it('BRACKET picks the band whose ceiling covers gross', () => {
    const brackets = [{ upTo: 20000, amount: 900 }, { upTo: null, amount: 1350 }];
    expect(amount({ method: 'BRACKET', amount: null, percent: null, brackets }, 15000)).toBe(900);
    expect(amount({ method: 'BRACKET', amount: null, percent: null, brackets }, 30000)).toBe(1350);
  });

  it('BRACKET is order-independent — bands entered top-first still work (the #3 fix)', () => {
    const outOfOrder = [{ upTo: null, amount: 1350 }, { upTo: 20000, amount: 900 }];
    expect(amount({ method: 'BRACKET', amount: null, percent: null, brackets: outOfOrder }, 15000)).toBe(900);
    expect(amount({ method: 'BRACKET', amount: null, percent: null, brackets: outOfOrder }, 30000)).toBe(1350);
  });
});

// ── Integration against the live DB: authorization-based OT (#1/#2) + cap (#5)
describe('computeEarnings — authorization-based overtime + session cap', () => {
  let orgId: string;
  let empId: string;
  const day = '2026-06-01';
  const periodStart = new Date(`${day}T00:00:00`);
  const periodEndExcl = new Date('2026-06-02T00:00:00');

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'TEST-OT-' + Date.now(), timezone: 'Asia/Manila' } });
    orgId = org.id;
    await prisma.shiftPolicy.create({ data: { orgId, name: 'T', shiftHours: 8, otMultiplier: 1.5, nightDiffPercent: 10 } });
    const emp = await prisma.employee.create({
      data: { orgId, employeeCode: 'OT-1', fullName: 'OT Tester', hireDate: new Date(), hourlyRate: 100 },
    });
    empId = emp.id;
  });

  afterAll(async () => {
    await cleanupOrg(prisma, orgId);
  });

  async function resetShift() {
    const tes = await prisma.timeEntry.findMany({ where: { employeeId: empId }, select: { id: true } });
    const teIds = tes.map((t) => t.id);
    await prisma.activitySession.deleteMany({ where: { timeEntryId: { in: teIds } } });
    await prisma.breakEntry.deleteMany({ where: { timeEntryId: { in: teIds } } });
    await prisma.timeEntry.deleteMany({ where: { employeeId: empId } });
    await prisma.schedule.deleteMany({ where: { employeeId: empId } });
  }

  const earn = () => (ctrl as any).computeEarnings(orgId, periodStart, periodEndExcl, empId);

  it('pays OT only for worked time inside an authorized OT window', async () => {
    await resetShift();
    const clockIn = new Date(`${day}T18:00:00`);
    const clockOut = new Date(`${day}T22:00:00`); // 4h worked
    const te = await prisma.timeEntry.create({
      data: { employeeId: empId, clockInAt: clockIn, shiftEndsAt: new Date(`${day}T23:00:00`), clockOutAt: clockOut, status: 'CLOSED' },
    });
    await prisma.activitySession.create({ data: { timeEntryId: te.id, activityType: 'Inbound Calls', startedAt: clockIn, endedAt: clockOut } });
    // WFM-authorized OT window 20:00–22:00 (2h)
    await prisma.schedule.create({
      data: { employeeId: empId, workDate: new Date(`${day}T00:00:00Z`), otStart: new Date(`${day}T20:00:00`), otEnd: new Date(`${day}T22:00:00`) },
    });

    const [row] = await earn();
    expect(row.overtimeHours).toBeCloseTo(2, 5);
    expect(row.regularHours).toBeCloseTo(2, 5);
  });

  it('pays NO overtime without an authorized window, even past 8h worked', async () => {
    await resetShift();
    const clockIn = new Date(`${day}T14:00:00`);
    const clockOut = new Date(`${day}T23:00:00`); // 9h worked, no OT window
    const te = await prisma.timeEntry.create({
      data: { employeeId: empId, clockInAt: clockIn, shiftEndsAt: new Date('2026-06-02T00:00:00'), clockOutAt: clockOut, status: 'CLOSED' },
    });
    await prisma.activitySession.create({ data: { timeEntryId: te.id, activityType: 'Inbound Calls', startedAt: clockIn, endedAt: clockOut } });

    const [row] = await earn();
    expect(row.overtimeHours).toBe(0);
    expect(row.regularHours).toBeCloseTo(9, 5);
    expect(row.nightHours).toBeCloseTo(1, 5); // 22:00–23:00 falls in the 22:00–06:00 night window
  });

  it('caps a still-open session at the shift end, not "now" (#5)', async () => {
    await resetShift();
    const clockIn = new Date(`${day}T08:00:00`);
    const shiftEnds = new Date(`${day}T16:00:00`); // 8h window, already in the past
    const te = await prisma.timeEntry.create({
      data: { employeeId: empId, clockInAt: clockIn, shiftEndsAt: shiftEnds, status: 'OPEN' },
    });
    await prisma.activitySession.create({ data: { timeEntryId: te.id, activityType: 'Productive', startedAt: clockIn, endedAt: null } }); // never closed

    const [row] = await earn();
    // Capped at 16:00 → 8h. Without the cap it would bill all the way to the period end.
    expect(row.regularHours).toBeCloseTo(8, 5);
  });
});
