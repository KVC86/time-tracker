// =====================================================================
//  Seed: org + FAST-TEST policy + team + ONE default account.
//   - Alex Cruz (WFM-01) → WFM → MFA via authenticator app (TOTP)
//  The default account is a Workforce Management (WFM) user — the
//  scheduling authority for the org. Additional users (agents, team
//  leads, managers) are created from the app's admin endpoints, not seeded.
//  Prints credentials + IDs for testing.
// =====================================================================

import { PrismaClient, Role } from '@prisma/client';
import { hash } from '@node-rs/argon2';

const prisma = new PrismaClient();
const PASSWORD = 'Password123!';

async function main() {
  // The seeded account uses a weak, printed demo password. Never seed a
  // production database with it; override only if you truly mean to.
  if (process.env.NODE_ENV === 'production' && !process.env.ALLOW_PROD_SEED) {
    throw new Error(
      'Refusing to seed demo credentials in production. ' +
        'Set ALLOW_PROD_SEED=1 to override (not recommended).',
    );
  }

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

  // The single default account: a Workforce Management (WFM) user.
  const wfm = await prisma.employee.create({
    data: { orgId: org.id, teamId: team.id, employeeCode: 'WFM-01', fullName: 'Alex Cruz', hireDate: new Date() },
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

  // Assign every default activity to the whole team so agents (once created)
  // can clock in out of the box. WFM/Team Leads can re-target these later.
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
      employeeId: wfm.id,
      email: 'alex.cruz@acme.test',
      passwordHash: pwHash,
      roles: [Role.WFM],
    },
  });

  console.log('\n=== SEED COMPLETE =========================================');
  console.log('Default account — WFM (TOTP app MFA):');
  console.log('   login: alex.cruz@acme.test   OR   WFM-01');
  console.log('   employeeId:', wfm.id);
  console.log('   password :', PASSWORD);
  console.log('-----------------------------------------------------------');
  console.log('Create additional users (agents, team leads, managers) from');
  console.log('the admin endpoints once signed in as WFM.');
  console.log('===========================================================\n');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
