import { PrismaClient } from '@prisma/client';
import { EnforcementWorker } from '../src/time-tracking/break-enforcement.service';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();
// enforceBreak only touches prisma + the events publisher, so stub the events.
const events = { toEmployee: () => {}, toApprovers: () => {}, toActivity: () => {} };
const worker = new EnforcementWorker(prisma as any, events as any);

afterAll(async () => {
  await prisma.$disconnect();
});

// ── A break overrun by a floor-level employee auto-clocks them out and stops
//    paid-time tracking (privileged staff keep the gentler resume behavior —
//    see break-overrun-clockout.spec.ts).
describe('enforceBreak — overrun auto-clocks-out a floor employee', () => {
  let orgId: string;
  let empId: string;
  let teId: string;
  let breakId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'TEST-ENF-' + Date.now(), timezone: 'Asia/Manila' } });
    orgId = org.id;
    const emp = await prisma.employee.create({ data: { orgId, employeeCode: 'ENF-1', fullName: 'Enf Tester', hireDate: new Date() } });
    empId = emp.id;

    const now = Date.now();
    const te = await prisma.timeEntry.create({
      data: {
        employeeId: empId,
        clockInAt: new Date(now - 3_600_000),
        shiftEndsAt: new Date(now + 7 * 3_600_000),
        status: 'OPEN',
      },
    });
    teId = te.id;
    // The activity the employee was on before the break (already closed, as it is during a break).
    await prisma.activitySession.create({
      data: { timeEntryId: teId, activityType: 'Inbound Calls', startedAt: new Date(now - 1_800_000), endedAt: new Date(now - 300_000) },
    });
    // An open break whose deadline is already in the past → eligible for enforcement.
    const brk = await prisma.breakEntry.create({
      data: { timeEntryId: teId, breakType: 'BIO', startedAt: new Date(now - 300_000), deadlineAt: new Date(now - 60_000) },
    });
    breakId = brk.id;
  });

  afterAll(async () => {
    await cleanupOrg(prisma, orgId);
  });

  it('ends the break (exceeded), closes the shift, and stops paid-time tracking', async () => {
    await (worker as any).enforceBreak(breakId);

    const brk = await prisma.breakEntry.findUnique({ where: { id: breakId } });
    expect(brk!.endedAt).not.toBeNull();
    expect(brk!.exceeded).toBe(true);

    const te = await prisma.timeEntry.findUnique({ where: { id: teId } });
    expect(te!.status).toBe('AUTO_CLOSED'); // auto-clocked-out on overrun
    expect(te!.clockOutAt).not.toBeNull();

    // Paid-time tracking stopped: no session left open, and none resumed.
    const open = await prisma.activitySession.findFirst({
      where: { timeEntryId: teId, endedAt: null },
    });
    expect(open).toBeNull();

    // A compliance violation is recorded, noting the auto-clock-out.
    const v = await prisma.complianceViolation.findFirst({
      where: { employeeId: empId, type: 'BREAK_OVERRUN' },
    });
    expect(v).not.toBeNull();
    expect(v!.detail).toMatch(/auto-clocked-out/);
  });
});
