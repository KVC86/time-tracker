// =====================================================================
//  Seed: org + FAST-TEST policy + team + two people WITH LOGINS.
//   - John Doe  (EMP-12)  → EMPLOYEE  → MFA via emailed OTP
//   - Jane Smith (TL-04)  → TEAM_LEAD → MFA via authenticator app (TOTP)
//  Prints credentials + IDs for testing.
// =====================================================================

import { PrismaClient, Role } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const prisma = new PrismaClient();
const PASSWORD = 'Password123!';

async function main() {
  const org = await prisma.organization.create({
    data: { name: 'Acme BPO', timezone: 'Asia/Manila' },
  });

  const policy = await prisma.shiftPolicy.create({
    data: {
      orgId: org.id,
      name: 'FAST-TEST',
      shiftHours: 8,
      regUnlockHours: 1,
      regMaxSeconds: 1800,
      regPerShift: 1,
      bioMaxSeconds: 180,  // bio break auto-clocks-out after 3 min
      bioPerShift: 3,      // floor staff: 3 bio breaks per shift (mgmt is unlimited)
      addlMaxSeconds: 120, // additional bio break: 2 min
      graceSeconds: 0,
    },
  });

  const dept = await prisma.department.create({
    data: { orgId: org.id, name: 'Operations' },
  });
  const team = await prisma.team.create({
    data: { departmentId: dept.id, name: 'Team Alpha', policyId: policy.id },
  });

  const employee = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'EMP-12', fullName: 'John Doe', hireDate: new Date(), hourlyRate: 100 },
  });
  const teamLead = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'TL-04', fullName: 'Jane Smith', hireDate: new Date(), hourlyRate: 150 },
  });
  const wfm = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'WFM-01', fullName: 'Alex Cruz', hireDate: new Date() },
  });
  const manager = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'MGR-01', fullName: 'Maria Santos', hireDate: new Date() },
  });
  const payroll = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'PAY-01', fullName: 'Riya Dev', hireDate: new Date() },
  });

  const defaultActivities = [
    'Productive',
    'Client Meeting',
    'Inbound Calls',
    'Outbound Calls',
    'Email Support',
    'Chat Support',
    'Escalations Support',
    'Training',
  ];
  await prisma.activityType.createMany({
    data: defaultActivities.map(name => ({ orgId: org.id, name })),
  });

  // Assign every default activity to the whole team so agents can clock in
  // out of the box. Team Leads can later re-target these per employee/team.
  const createdActivities = await prisma.activityType.findMany({
    where: { orgId: org.id },
    select: { id: true },
  });
  await prisma.activityAssignment.createMany({
    data: createdActivities.map(a => ({ activityTypeId: a.id, teamId: team.id })),
  });

  const pwHash = await hash(PASSWORD);
  await prisma.user.create({
    data: {
      employeeId: employee.id,
      email: 'john.doe@acme.test',
      passwordHash: pwHash,
      roles: [Role.EMPLOYEE],
    },
  });
  await prisma.user.create({
    data: {
      employeeId: teamLead.id,
      email: 'jane.smith@acme.test',
      passwordHash: pwHash,
      roles: [Role.TEAM_LEAD],
    },
  });
  await prisma.user.create({
    data: {
      employeeId: wfm.id,
      email: 'alex.cruz@acme.test',
      passwordHash: pwHash,
      roles: [Role.WFM],
    },
  });
  await prisma.user.create({
    data: {
      employeeId: manager.id,
      email: 'maria.santos@acme.test',
      passwordHash: pwHash,
      roles: [Role.MANAGER],
    },
  });
  await prisma.user.create({
    data: {
      employeeId: payroll.id,
      email: 'payroll@acme.test',
      passwordHash: pwHash,
      roles: [Role.PAYROLL],
    },
  });

  console.log('\n=== SEED COMPLETE =========================================');
  console.log('AGENT  (email OTP MFA):');
  console.log('   login: john.doe@acme.test   OR   EMP-12');
  console.log('   employeeId:', employee.id);
  console.log('TEAM LEAD (TOTP app MFA):');
  console.log('   login: jane.smith@acme.test  OR   TL-04');
  console.log('   employeeId:', teamLead.id);
  console.log('WFM (TOTP app MFA):');
  console.log('   login: alex.cruz@acme.test   OR   WFM-01');
  console.log('   employeeId:', wfm.id);
  console.log('MANAGER (TOTP app MFA):');
  console.log('   login: maria.santos@acme.test OR  MGR-01');
  console.log('   employeeId:', manager.id);
  console.log('PAYROLL (TOTP app MFA):');
  console.log('   login: payroll@acme.test      OR  PAY-01');
  console.log('   employeeId:', payroll.id);
  console.log('Password for all:', PASSWORD);
  console.log('===========================================================\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
