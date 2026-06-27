import { PrismaClient, Role } from '@prisma/client';
import { EnforcementWorker } from '../src/time-tracking/break-enforcement.service';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();
// enforceBreak only calls toEmployee/toApprovers; a no-op stub is enough.
const events = { toEmployee() {}, toApprovers() {} } as any;

// Construct the worker WITHOUT onModuleInit, so no BullMQ worker/Redis spins up.
// We invoke the private enforceBreak directly — same pattern as the schedules test.
const worker = new EnforcementWorker(prisma as any, events);
const enforce = (breakId: string): Promise<void> => (worker as any).enforceBreak(breakId);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('enforceBreak — break overrun', () => {
  let orgId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'TEST-OVR-' + Date.now(), timezone: 'Asia/Manila' } });
    orgId = org.id;
    await prisma.shiftPolicy.create({ data: { orgId, name: 'T', shiftHours: 8 } });
  });

  afterAll(async () => {
    // cleanupOrg doesn't remove User rows; delete them first to avoid the
    // employee FK, then let the shared helper tear down the rest.
    const emps = await prisma.employee.findMany({ where: { orgId }, select: { id: true } });
    await prisma.user.deleteMany({ where: { employeeId: { in: emps.map((e) => e.id) } } });
    await cleanupOrg(prisma, orgId);
  });

  // Build a clocked-in person who is mid-break and already past the deadline.
  async function makeOverrun(code: string, roles: Role[]) {
    const emp = await prisma.employee.create({
      data: { orgId, employeeCode: code, fullName: code, hireDate: new Date() },
    });
    await prisma.user.create({
      data: { employeeId: emp.id, email: `${code.toLowerCase()}.${orgId}@ovr.test`, passwordHash: 'x', roles },
    });
    const now = Date.now();
    const te = await prisma.timeEntry.create({
      data: {
        employeeId: emp.id,
        clockInAt: new Date(now - 60 * 60 * 1000),       // clocked in 1h ago
        shiftEndsAt: new Date(now + 7 * 60 * 60 * 1000),  // 8h window, not yet expired
        status: 'OPEN',
      },
    });
    // The pre-break activity session was closed when the break started.
    await prisma.activitySession.create({
      data: { timeEntryId: te.id, activityType: 'Inbound Calls',
        startedAt: new Date(now - 60 * 60 * 1000), endedAt: new Date(now - 5 * 60 * 1000) },
    });
    // An OPEN bio break whose deadline has already passed.
    const brk = await prisma.breakEntry.create({
      data: { timeEntryId: te.id, breakType: 'BIO',
        startedAt: new Date(now - 5 * 60 * 1000), deadlineAt: new Date(now - 10 * 1000) },
    });
    return { empId: emp.id, teId: te.id, breakId: brk.id };
  }

  it('AUTO-CLOCKS-OUT a floor-level employee and stops paid-time tracking', async () => {
    const { empId, teId, breakId } = await makeOverrun('EMP-OVR', [Role.EMPLOYEE]);

    await enforce(breakId);

    const te = await prisma.timeEntry.findUnique({ where: { id: teId } });
    expect(te?.status).toBe('AUTO_CLOSED');     // clocked out
    expect(te?.clockOutAt).not.toBeNull();      // clock-out time recorded

    // Paid-time tracking stopped: no activity session is left open, and NO new
    // "resume" session was created.
    const sessions = await prisma.activitySession.findMany({ where: { timeEntryId: teId } });
    expect(sessions).toHaveLength(1);                       // none added
    expect(sessions.every((s) => s.endedAt !== null)).toBe(true); // none still running

    const brk = await prisma.breakEntry.findUnique({ where: { id: breakId } });
    expect(brk?.endedAt).not.toBeNull();
    expect(brk?.exceeded).toBe(true);

    const viol = await prisma.complianceViolation.findFirst({
      where: { employeeId: empId, type: 'BREAK_OVERRUN' },
    });
    expect(viol?.detail).toMatch(/auto-clocked-out/);
  });

  it('does NOT clock out a privileged user (Team Lead) — ends break and resumes work', async () => {
    const { teId, breakId } = await makeOverrun('TL-OVR', [Role.TEAM_LEAD]);

    await enforce(breakId);

    const te = await prisma.timeEntry.findUnique({ where: { id: teId } });
    expect(te?.status).toBe('OPEN');            // shift stays open
    expect(te?.clockOutAt).toBeNull();

    // A new activity session was opened to resume work.
    const open = await prisma.activitySession.findMany({ where: { timeEntryId: teId, endedAt: null } });
    expect(open).toHaveLength(1);

    const brk = await prisma.breakEntry.findUnique({ where: { id: breakId } });
    expect(brk?.endedAt).not.toBeNull();
    expect(brk?.exceeded).toBe(true);
  });
});
