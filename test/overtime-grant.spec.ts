import { PrismaClient } from '@prisma/client';
import { SchedulesController } from '../src/scheduling/schedules.controller';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();
const events = { toEmployee() {}, toApprovers() {}, toActivity() {} } as any;
const ctrl = new SchedulesController(prisma as any, events);

afterAll(async () => {
  await prisma.$disconnect();
});

// ── Integration: the separately-managed overtime grant (date + start + hours) ──
describe('overtime grants — date + start time + hours', () => {
  let orgId: string;
  let empId: string;
  const req = () => ({ user: { userId: 'u', employeeId: empId, roles: ['WFM'] } }) as any;
  const workDate = (d: string) => new Date(`${d}T00:00:00.000Z`);

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'TEST-OTG-' + Date.now(), timezone: 'Asia/Manila' } });
    orgId = org.id;
    await prisma.shiftPolicy.create({ data: { orgId, name: 'T', shiftHours: 8 } });
    const emp = await prisma.employee.create({
      data: { orgId, employeeCode: 'OTG-1', fullName: 'OT Grant Tester', hireDate: new Date(), hourlyRate: 100 },
    });
    empId = emp.id;
  });

  afterEach(async () => {
    await prisma.schedule.deleteMany({ where: { employeeId: empId } });
  });

  afterAll(async () => {
    await cleanupOrg(prisma, orgId);
  });

  it('grants OT on a bare date as ordinary OT (not rest day) and stores start + N hours', async () => {
    const res = await ctrl.grantOvertime(req(), { employeeId: empId, date: '2026-08-15', startTime: '18:00', hours: 3 });
    expect(res.ok).toBe(true);
    expect(res.isRestDay).toBe(false); // bare date is NOT a rest day
    expect(res.classification).toBe('OT'); // 6–9 PM is daytime
    expect(res.hours).toBe(3);
    const row = await prisma.schedule.findUnique({ where: { employeeId_workDate: { employeeId: empId, workDate: workDate('2026-08-15') } } });
    expect(row!.isRestDay).toBe(false);
    expect(row!.scheduledStart).toBeNull();
    expect((row!.otEnd!.getTime() - row!.otStart!.getTime()) / 3_600_000).toBeCloseTo(3, 5);
  });

  it('grants OT on a scheduled rest day as RDOT', async () => {
    await prisma.schedule.create({
      data: { employeeId: empId, workDate: workDate('2026-08-20'), isRestDay: true, scheduledStart: null, scheduledEnd: null },
    });
    const res = await ctrl.grantOvertime(req(), { employeeId: empId, date: '2026-08-20', startTime: '10:00', hours: 2 });
    expect(res.isRestDay).toBe(true);
    expect(res.classification).toBe('RDOT');
  });

  it('grants OT on an existing working day as ordinary OT, preserving the shift', async () => {
    await prisma.schedule.create({
      data: { employeeId: empId, workDate: workDate('2026-08-16'), isRestDay: false,
        scheduledStart: new Date('2026-08-16T09:00:00'), scheduledEnd: new Date('2026-08-16T17:00:00') },
    });
    const res = await ctrl.grantOvertime(req(), { employeeId: empId, date: '2026-08-16', startTime: '17:00', hours: 2 });
    expect(res.isRestDay).toBe(false); // rides on the shift → ordinary OT
    const row = await prisma.schedule.findUnique({ where: { employeeId_workDate: { employeeId: empId, workDate: workDate('2026-08-16') } } });
    expect(row!.scheduledStart).not.toBeNull(); // shift preserved
    expect(row!.otStart).not.toBeNull();
  });

  it('lists grants with computed hours + classification, and clearing a bare OT day removes the row', async () => {
    const g = await ctrl.grantOvertime(req(), { employeeId: empId, date: '2026-08-17', startTime: '10:00', hours: 2.5 });
    const list = await ctrl.listOvertime(req(), empId);
    expect(list.length).toBe(1);
    expect(list[0].hours).toBe(2.5);
    expect(list[0].isRestDay).toBe(false);
    expect(list[0].classification).toBe('OT');

    await ctrl.clearOvertime(req(), g.id);
    const row = await prisma.schedule.findUnique({ where: { employeeId_workDate: { employeeId: empId, workDate: workDate('2026-08-17') } } });
    expect(row).toBeNull(); // OT-only row (no shift, not a rest day) is removed on clear
  });

  it('rejects invalid hours', async () => {
    await expect(ctrl.grantOvertime(req(), { employeeId: empId, date: '2026-08-18', startTime: '18:00', hours: 0 }))
      .rejects.toThrow(/hours/);
  });
});
