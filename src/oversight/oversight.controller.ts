import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role, TimeEntryStatus } from '@prisma/client';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

// Higher management can be scheduled/managed, but never monitored here.
const MGMT_ROLES: Role[] = ['MANAGER', 'WFM', 'HR', 'PAYROLL', 'ADMIN'];

// Manager oversight: a read-only live board + violations feed for floor agents
// and team leads. (Screen viewing is consent-based and handled over WebRTC.)
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('MANAGER', 'HR', 'ADMIN')
@Controller('oversight')
export class OversightController {
  constructor(private readonly prisma: PrismaService) {}

  /** Floor agents + team leads in the caller's scope:
   *  MANAGER → their department; HR/ADMIN → the whole org. */
  private async monitored(req: AuthedReq) {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true },
    });
    if (!me) return [];
    // HR/Admin see the whole org; a Manager sees employees on the teams they
    // are assigned to manage (team.managerId), i.e. those teams' TLs + floor staff.
    const broad = req.user.roles.includes('HR' as Role) || req.user.roles.includes('ADMIN' as Role);
    const where = broad
      ? { orgId: me.orgId }
      : { team: { managerId: req.user.employeeId } };

    const employees = await this.prisma.employee.findMany({
      where: { ...where, active: true },
      select: {
        id: true,
        employeeCode: true,
        fullName: true,
        user: { select: { roles: true } },
      },
      orderBy: { employeeCode: 'asc' },
    });
    return employees
      .filter((e) => !(e.user?.roles ?? []).some((r) => MGMT_ROLES.includes(r)))
      .map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        role: (e.user?.roles ?? []).includes('TEAM_LEAD' as Role) ? 'TEAM_LEAD' : 'EMPLOYEE',
      }));
  }

  /** Live status board: who's on shift / on break / clocked out, with how long. */
  @Get()
  async board(@Req() req: AuthedReq) {
    const people = await this.monitored(req);
    const ids = people.map((p) => p.id);

    const openEntries = await this.prisma.timeEntry.findMany({
      where: { employeeId: { in: ids }, status: TimeEntryStatus.OPEN },
      include: {
        breaks: { where: { endedAt: null } },
        activities: { where: { endedAt: null }, orderBy: { startedAt: 'desc' }, take: 1 },
      },
    });
    const byEmp = new Map(openEntries.map((e) => [e.employeeId, e]));

    return people.map((p) => {
      const entry = byEmp.get(p.id);
      if (!entry) return { ...p, status: 'OFF' };
      const brk = entry.breaks[0];
      const act = entry.activities[0];
      return {
        ...p,
        status: brk ? 'BREAK' : 'WORKING',
        breakType: brk?.breakType ?? null,
        breakSince: brk?.startedAt ?? null,
        activity: act?.activityType ?? null,
        activitySince: act?.startedAt ?? null,
        clockInAt: entry.clockInAt,
        shiftEndsAt: entry.shiftEndsAt,
      };
    });
  }

  /** Recent compliance violations by agents and team leads in scope. */
  @Get('violations')
  async violations(@Req() req: AuthedReq) {
    const people = await this.monitored(req);
    const byId = new Map(people.map((p) => [p.id, p]));

    const rows = await this.prisma.complianceViolation.findMany({
      where: { employeeId: { in: people.map((p) => p.id) } },
      orderBy: { occurredAt: 'desc' },
      take: 50,
    });
    return rows.map((v) => ({
      id: v.id,
      employeeId: v.employeeId,
      employeeCode: byId.get(v.employeeId)?.employeeCode ?? '',
      fullName: byId.get(v.employeeId)?.fullName ?? '',
      type: v.type,
      detail: v.detail,
      occurredAt: v.occurredAt,
    }));
  }
}
