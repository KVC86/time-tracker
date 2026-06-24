import { PrismaClient } from '@prisma/client';

/** Delete an entire test organization and everything under it, in FK-safe order. */
export async function cleanupOrg(prisma: PrismaClient, orgId: string) {
  const emps = await prisma.employee.findMany({ where: { orgId }, select: { id: true } });
  const empIds = emps.map((e) => e.id);
  const tes = await prisma.timeEntry.findMany({ where: { employeeId: { in: empIds } }, select: { id: true } });
  const teIds = tes.map((t) => t.id);

  await prisma.payslipLine.deleteMany({ where: { payslip: { employeeId: { in: empIds } } } });
  await prisma.payslip.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.breakEntry.deleteMany({ where: { timeEntryId: { in: teIds } } });
  await prisma.activitySession.deleteMany({ where: { timeEntryId: { in: teIds } } });
  await prisma.timeEntry.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.schedule.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.payComponent.deleteMany({ where: { orgId } });
  await prisma.complianceViolation.deleteMany({ where: { employeeId: { in: empIds } } });
  await prisma.breakApproval.deleteMany({
    where: { OR: [{ employeeId: { in: empIds } }, { grantedById: { in: empIds } }] },
  });
  await prisma.leaveRequest.deleteMany({
    where: { OR: [{ employeeId: { in: empIds } }, { reviewedById: { in: empIds } }] },
  });
  await prisma.employee.deleteMany({ where: { orgId } });
  await prisma.shiftPolicy.deleteMany({ where: { orgId } });
  await prisma.activityType.deleteMany({ where: { orgId } });
  await prisma.organization.delete({ where: { id: orgId } });
}
