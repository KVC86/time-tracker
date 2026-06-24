import { PrismaClient } from '@prisma/client';
import { SchedulesController } from '../src/scheduling/schedules.controller';
import { cleanupOrg } from './helpers';

const prisma = new PrismaClient();
// checkCompliance never touches the events publisher; a stub is enough.
const events = { toEmployee() {}, toApprovers() {} } as any;
const ctrl = new SchedulesController(prisma as any, events);

afterAll(async () => {
  await prisma.$disconnect();
});

// ── Integration against the live DB: the schedule ↔ leave conflict warnings ──
describe('checkCompliance — leave conflicts', () => {
  let orgId: string;
  let empId: string;

  beforeAll(async () => {
    const org = await prisma.organization.create({ data: { name: 'TEST-LV-' + Date.now(), timezone: 'Asia/Manila' } });
    orgId = org.id;
    // A policy must exist or checkCompliance short-circuits to no warnings.
    await prisma.shiftPolicy.create({ data: { orgId, name: 'T', shiftHours: 8 } });
    const emp = await prisma.employee.create({
      data: { orgId, employeeCode: 'LV-1', fullName: 'Leave Tester', hireDate: new Date(), hourlyRate: 100 },
    });
    empId = emp.id;
  });

  afterAll(async () => {
    await cleanupOrg(prisma, orgId);
  });

  // A single 09:00–17:00 working row for the given calendar date.
  const workRow = (ds: string) => ({
    employeeId: empId,
    workDate: new Date(ds), // 'YYYY-MM-DD' → UTC midnight, matches how apply() builds rows
    isRestDay: false,
    scheduledStart: new Date(`${ds}T09:00:00`),
    scheduledEnd: new Date(`${ds}T17:00:00`),
    otStart: null,
    otEnd: null,
    isNightShift: false,
  });
  const restRow = (ds: string) => ({
    employeeId: empId, workDate: new Date(ds), isRestDay: true,
    scheduledStart: null, scheduledEnd: null, otStart: null, otEnd: null, isNightShift: false,
  });

  const check = (rows: any[]): Promise<string[]> => (ctrl as any).checkCompliance(orgId, rows);

  it('warns when a working day lands inside APPROVED leave', async () => {
    await prisma.leaveRequest.create({
      data: { employeeId: empId, leaveType: 'VACATION', status: 'APPROVED',
        startDate: new Date('2026-07-01'), endDate: new Date('2026-07-03') },
    });
    const warnings = await check([workRow('2026-07-02')]);
    expect(warnings.some((w) => /APPROVED VACATION leave \(2026-07-01–2026-07-03\)/.test(w))).toBe(true);
  });

  it('warns softly (not yet approved) when a working day lands inside PENDING leave', async () => {
    await prisma.leaveRequest.create({
      data: { employeeId: empId, leaveType: 'SICK', status: 'PENDING',
        startDate: new Date('2026-07-10'), endDate: new Date('2026-07-10') },
    });
    const warnings = await check([workRow('2026-07-10')]);
    expect(warnings.some((w) => /PENDING SICK leave request/.test(w) && /not yet approved/.test(w))).toBe(true);
  });

  it('does not warn for a rest day on a leave date, or a working day clear of any leave', async () => {
    // Rest day inside the approved-leave span → fine (no work scheduled).
    const restInside = await check([restRow('2026-07-02')]);
    expect(restInside.some((w) => /leave/.test(w))).toBe(false);
    // Working day outside every leave span → fine.
    const clear = await check([workRow('2026-08-15')]);
    expect(clear.some((w) => /leave/.test(w))).toBe(false);
  });
});
