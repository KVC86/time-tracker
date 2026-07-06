import { PrismaClient } from '@prisma/client';
import { TimeTrackingService } from '../src/time-tracking/time-tracking.service';
import { manilaWorkDate } from '../src/common/timezone';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();

// clockIn() only calls scheduleShiftExpiry() on the enforcement service and the
// three publisher methods — stubbing both keeps this test free of Redis and the
// WebSocket gateway while exercising the real DB-backed schedule/OT gate.
const enforcement = { scheduleShiftExpiry: async () => {} } as any;
const events = { toEmployee() {}, toApprovers() {}, toActivity() {} } as any;
const svc = new TimeTrackingService(prisma as any, enforcement, events);

const HOUR = 3600_000;
const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

// ── Integration against the live DB: schedule-gated clock-in, widened by OT ──
describe('clockIn — schedule-gated login with overtime', () => {
  let orgId: string;
  let empId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'TEST-OT-' + Date.now(), timezone: 'Asia/Manila' },
    });
    orgId = org.id;
    // getPolicy() falls back to the org's default policy (no team set).
    await prisma.shiftPolicy.create({ data: { orgId, name: 'T', shiftHours: 8 } });
    const emp = await prisma.employee.create({
      data: { orgId, employeeCode: 'OT-1', fullName: 'OT Tester', hireDate: new Date(), hourlyRate: 100 },
    });
    empId = emp.id;
  });

  // Each test starts clean: no open/closed entries, schedules, or violations.
  afterEach(async () => {
    const tes = await prisma.timeEntry.findMany({ where: { employeeId: empId }, select: { id: true } });
    const teIds = tes.map((t) => t.id);
    await prisma.activitySession.deleteMany({ where: { timeEntryId: { in: teIds } } });
    await prisma.timeEntry.deleteMany({ where: { employeeId: empId } });
    await prisma.schedule.deleteMany({ where: { employeeId: empId } });
    await prisma.complianceViolation.deleteMany({ where: { employeeId: empId } });
  });

  afterAll(async () => {
    await cleanupOrg(prisma, orgId);
    await prisma.$disconnect();
  });

  const setSchedule = (
    data: Partial<{
      scheduledStart: Date | null;
      scheduledEnd: Date | null;
      otStart: Date | null;
      otEnd: Date | null;
      isRestDay: boolean;
    }>,
  ) =>
    prisma.schedule.create({
      data: {
        employeeId: empId,
        workDate: manilaWorkDate(),
        scheduledStart: null,
        scheduledEnd: null,
        otStart: null,
        otEnd: null,
        isRestDay: false,
        isNightShift: false,
        ...data,
      },
    });

  const clockIn = () => svc.clockIn(empId, 'Productivity', { userId: 'test' });
  const violationType = async () =>
    (await prisma.complianceViolation.findFirst({ where: { employeeId: empId } }))?.type;

  it('blocks a clock-in before the scheduled start (and logs a violation)', async () => {
    await setSchedule({ scheduledStart: at(2 * HOUR), scheduledEnd: at(10 * HOUR) });
    await expect(clockIn()).rejects.toThrow(/Too early/);
    expect(await violationType()).toBe('OUT_OF_SCHEDULE_LOGIN');
  });

  it('blocks a clock-in after the scheduled end when no OT is granted', async () => {
    await setSchedule({ scheduledStart: at(-10 * HOUR), scheduledEnd: at(-2 * HOUR) });
    await expect(clockIn()).rejects.toThrow(/already ended/);
    expect(await violationType()).toBe('OUT_OF_SCHEDULE_LOGIN');
  });

  it('ALLOWS a clock-in past the scheduled end when OT covers now, and auto-expiry follows the OT end', async () => {
    const otEnd = at(2 * HOUR);
    await setSchedule({
      scheduledStart: at(-10 * HOUR),
      scheduledEnd: at(-2 * HOUR),
      otStart: at(-2 * HOUR),
      otEnd,
    });
    const state = await clockIn();
    expect(state.onShift).toBe(true);
    const te = await prisma.timeEntry.findFirst({ where: { employeeId: empId, status: 'OPEN' } });
    expect(te).toBeTruthy();
    // shiftEndsAt is the WIDENED window end (OT end), not the scheduled end.
    expect(Math.abs(te!.shiftEndsAt.getTime() - otEnd.getTime())).toBeLessThan(1000);
    // A legitimate OT login records no violation.
    expect(await violationType()).toBeUndefined();
  });

  it('blocks a rest-day clock-in, but ALLOWS it when OT is granted for the rest day', async () => {
    await setSchedule({ isRestDay: true });
    await expect(clockIn()).rejects.toThrow(/rest day/);

    await prisma.schedule.deleteMany({ where: { employeeId: empId } });
    await setSchedule({ isRestDay: true, otStart: at(-1 * HOUR), otEnd: at(1 * HOUR) });
    const state = await clockIn();
    expect(state.onShift).toBe(true);
  });
});
