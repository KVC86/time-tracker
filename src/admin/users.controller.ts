import {
  Controller,
  Get,
  Post,
  Body,
  Req,
  UseGuards,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

// WFM can provision these three; higher roles (WFM/HR/ADMIN) stay with Admin.
const CREATABLE: Role[] = ['EMPLOYEE', 'TEAM_LEAD', 'MANAGER', 'PAYROLL'];
const PREFIX: Record<string, string> = { EMPLOYEE: 'EMP', TEAM_LEAD: 'TL', MANAGER: 'MGR', PAYROLL: 'PAY' };

@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('WFM', 'ADMIN')
@Controller('admin/users')
export class UsersController {
  constructor(private readonly prisma: PrismaService) {}

  /** Everyone in the caller's org, with their login + roles. */
  @Get()
  async list(@Req() req: AuthedReq) {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true },
    });
    if (!me) return [];
    const employees = await this.prisma.employee.findMany({
      where: { orgId: me.orgId },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        active: true,
        user: { select: { email: true, roles: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });
    return employees.map((e) => ({
      id: e.id,
      employeeCode: e.employeeCode,
      fullName: e.fullName,
      email: e.user?.email ?? null,
      roles: e.user?.roles ?? [],
      active: e.active,
    }));
  }

  /** Create an EMP / TL / MGR with a login. Employee code is auto-generated. */
  @Post()
  async create(
    @Req() req: AuthedReq,
    @Body() body: { role: Role; fullName: string; email: string; password: string },
  ) {
    if (!CREATABLE.includes(body.role))
      throw new BadRequestException(`Role must be one of: ${CREATABLE.join(', ')}.`);
    const fullName = (body.fullName ?? '').trim();
    if (!fullName) throw new BadRequestException('Full name is required.');
    const email = (body.email ?? '').trim().toLowerCase();
    if (!email.includes('@')) throw new BadRequestException('A valid email is required.');
    if ((body.password ?? '').length < 8)
      throw new BadRequestException('Password must be at least 8 characters.');

    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true, teamId: true },
    });
    if (!me) throw new NotFoundException('Creator not found.');

    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing) throw new ConflictException('That email is already in use.');

    const employeeCode = await this.nextCode(me.orgId, body.role);
    const passwordHash = await hash(body.password);

    const employee = await this.prisma.employee.create({
      data: { orgId: me.orgId, teamId: me.teamId, employeeCode, fullName, hireDate: new Date() },
    });
    await this.prisma.user.create({
      data: { employeeId: employee.id, email, passwordHash, roles: [body.role] },
    });
    return { ok: true, employeeCode, fullName, email, role: body.role };
  }

  /** Next free code for a role's prefix, e.g. EMP-13, TL-05, MGR-02. */
  private async nextCode(orgId: string, role: Role): Promise<string> {
    const prefix = PREFIX[role];
    const rows = await this.prisma.employee.findMany({
      where: { orgId, employeeCode: { startsWith: `${prefix}-` } },
      select: { employeeCode: true },
    });
    let max = 0;
    for (const r of rows) {
      const n = parseInt(r.employeeCode.split('-')[1] ?? '', 10);
      if (!isNaN(n) && n > max) max = n;
    }
    return `${prefix}-${String(max + 1).padStart(2, '0')}`;
  }
}
