// Idempotent creation of the single experimental MFA-exempt floor employee.
// Run inside the app container (has @prisma/client, @node-rs/argon2, DATABASE_URL):
//   docker compose -f docker-compose.prod.yml exec -T app node < scripts/create-floor-user.js
const { PrismaClient } = require('@prisma/client');
const { hash } = require('@node-rs/argon2');

const EMAIL = 'mhe.gwapa@acme.test';
const CODE = 'EMP-MHE';
const FULL_NAME = 'Mhe Gwapa';
const PASSWORD = 'Password123!';

(async () => {
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findFirst({ orderBy: { createdAt: 'asc' } });
    if (!org) throw new Error('No organization found — seed the org first.');
    const team = await prisma.team.findFirst();

    const employee = await prisma.employee.upsert({
      where: { orgId_employeeCode: { orgId: org.id, employeeCode: CODE } },
      update: { fullName: FULL_NAME, teamId: team ? team.id : null },
      create: {
        orgId: org.id,
        teamId: team ? team.id : null,
        employeeCode: CODE,
        fullName: FULL_NAME,
        hireDate: new Date(),
      },
    });

    const passwordHash = await hash(PASSWORD);
    const user = await prisma.user.upsert({
      where: { email: EMAIL },
      update: { passwordHash, roles: ['EMPLOYEE'], mfaExempt: true, employeeId: employee.id },
      create: {
        email: EMAIL,
        passwordHash,
        roles: ['EMPLOYEE'],
        mfaExempt: true,
        employeeId: employee.id,
      },
    });

    console.log('OK ' + JSON.stringify({
      org: org.name,
      employeeId: employee.id,
      employeeCode: employee.employeeCode,
      userId: user.id,
      email: user.email,
      roles: user.roles,
      mfaExempt: user.mfaExempt,
    }));
  } catch (e) {
    console.error('CREATE_USER_FAILED: ' + (e && e.message ? e.message : e));
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
