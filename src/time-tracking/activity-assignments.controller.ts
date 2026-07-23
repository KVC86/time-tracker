import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { AssignActivityDto } from './activity-assignments.dto';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEventsPublisher } from './time-tracking.gateway';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

// Activity assignment: TLs/Managers assign org activity types to either an
// individual employee or a whole team. Employees only see what's assigned.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('WFM', 'ADMIN')
@Controller('activity-assignments')
export class ActivityAssignmentsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  /** Push a live "your activities changed" event to the affected employee(s). */
  private async notifyActivityChange(employeeId?: string | null, teamId?: string | null) {
    if (employeeId) {
      this.events.toEmployee(employeeId, { type: 'ACTIVITIES_UPDATED' });
    } else if (teamId) {
      const members = await this.prisma.employee.findMany({
        where: { teamId },
        select: { id: true },
      });
      for (const m of members) this.events.toEmployee(m.id, { type: 'ACTIVITIES_UPDATED' });
    }
  }

  /** Resolve the caller's org + the scope they can assign within. */
  private async scopeFor(req: AuthedReq) {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      include: { team: true },
    });
    if (!me) throw new NotFoundException('Employee not found');
    const roles = req.user.roles;
    // WFM has the global override → org-wide scope, like HR/Admin.
    const broad = roles.includes('WFM' as Role) || roles.includes('HR' as Role) || roles.includes('ADMIN' as Role);
    const manager = roles.includes('MANAGER' as Role);
    return { me, broad, manager, orgId: me.orgId };
  }

  /** Notify every active employee in an org that their activities changed. */
  private async notifyAllOrg(orgId: string) {
    const members = await this.prisma.employee.findMany({
      where: { orgId, active: true },
      select: { id: true },
    });
    for (const m of members) this.events.toEmployee(m.id, { type: 'ACTIVITIES_UPDATED' });
  }

  /** Employees + teams the caller may assign to, for the console pickers. */
  @Get('targets')
  async targets(@Req() req: AuthedReq) {
    const { me, broad, manager, orgId } = await this.scopeFor(req);

    let empWhere: any;
    let teamWhere: any;
    if (broad) {
      empWhere = { orgId };
      teamWhere = { department: { orgId } };
    } else if (manager && me.team) {
      empWhere = { team: { departmentId: me.team.departmentId } };
      teamWhere = { departmentId: me.team.departmentId };
    } else if (me.teamId) {
      empWhere = { teamId: me.teamId };
      teamWhere = { id: me.teamId };
    } else {
      return { employees: [], teams: [] };
    }

    const [employees, teams] = await Promise.all([
      this.prisma.employee.findMany({
        where: empWhere,
        select: { id: true, employeeCode: true, fullName: true },
        orderBy: { employeeCode: 'asc' },
      }),
      this.prisma.team.findMany({
        where: teamWhere,
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { employees, teams };
  }

  /** Active assignments for a target: ?employeeId, ?teamId, or ?all=1 (org-wide). */
  @Get()
  async list(
    @Req() req: AuthedReq,
    @Query('employeeId') employeeId?: string,
    @Query('teamId') teamId?: string,
    @Query('all') all?: string,
  ) {
    if (all === '1' || all === 'true') {
      const { orgId } = await this.scopeFor(req);
      return this.prisma.activityAssignment.findMany({
        where: { active: true, employeeId: null, teamId: null, activityType: { orgId } },
        include: { activityType: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'asc' },
      });
    }
    if ((!employeeId && !teamId) || (employeeId && teamId))
      throw new BadRequestException('Provide exactly one of employeeId, teamId, or all.');
    return this.prisma.activityAssignment.findMany({
      where: { active: true, employeeId: employeeId ?? undefined, teamId: teamId ?? undefined },
      include: { activityType: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** Assign an activity type to an employee, a team, or ALL members (org-wide,
   *  which also covers anyone added later). Org-wide = no employeeId/teamId. */
  @Post()
  async assign(@Req() req: AuthedReq, @Body() body: AssignActivityDto) {
    const { activityTypeId, employeeId, teamId } = body;
    if (!activityTypeId) throw new BadRequestException('activityTypeId is required.');
    if (employeeId && teamId)
      throw new BadRequestException('Provide at most one of employeeId or teamId.');
    const orgWide = !employeeId && !teamId;

    const { orgId } = await this.scopeFor(req);

    // Activity type must belong to the caller's org and be active.
    const at = await this.prisma.activityType.findUnique({ where: { id: activityTypeId } });
    if (!at || at.orgId !== orgId || !at.active)
      throw new NotFoundException('Activity type not found.');

    if (!orgWide) await this.assertTargetInScope(req, { employeeId, teamId });

    // Prevent duplicate active assignment for the same target (incl. org-wide).
    const dupe = await this.prisma.activityAssignment.findFirst({
      where: { activityTypeId, employeeId: employeeId ?? null, teamId: teamId ?? null, active: true },
    });
    if (dupe) throw new ConflictException('That activity is already assigned to this target.');

    const created = await this.prisma.activityAssignment.create({
      data: { activityTypeId, employeeId, teamId },
      include: { activityType: { select: { id: true, name: true } } },
    });
    if (orgWide) await this.notifyAllOrg(orgId);
    else await this.notifyActivityChange(employeeId, teamId);
    return created;
  }

  /** Remove an assignment (hard delete — re-assigning later just re-creates). */
  @Delete(':id')
  async remove(@Req() req: AuthedReq, @Param('id') id: string) {
    const existing = await this.prisma.activityAssignment.findUnique({
      where: { id },
      include: { activityType: { select: { orgId: true } } },
    });
    if (!existing) throw new NotFoundException('Assignment not found.');
    const orgWide = !existing.employeeId && !existing.teamId;
    if (!orgWide) await this.assertTargetInScope(req, { employeeId: existing.employeeId ?? undefined, teamId: existing.teamId ?? undefined });
    await this.prisma.activityAssignment.delete({ where: { id } });
    if (orgWide) await this.notifyAllOrg(existing.activityType.orgId);
    else await this.notifyActivityChange(existing.employeeId, existing.teamId);
    return { ok: true };
  }

  /** Verify the chosen employee/team falls within the caller's assignable scope. */
  private async assertTargetInScope(req: AuthedReq, t: { employeeId?: string; teamId?: string }) {
    const { me, broad, manager, orgId } = await this.scopeFor(req);

    if (t.employeeId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: t.employeeId },
        include: { team: true },
      });
      if (!emp || emp.orgId !== orgId) throw new NotFoundException('Target employee not found.');
      if (broad) return;
      if (manager && me.team) {
        if (emp.team?.departmentId === me.team.departmentId) return;
      } else if (me.teamId && emp.teamId === me.teamId) {
        return;
      }
      throw new ForbiddenException('That employee is outside your scope.');
    }

    if (t.teamId) {
      const team = await this.prisma.team.findUnique({
        where: { id: t.teamId },
        include: { department: true },
      });
      if (!team || team.department.orgId !== orgId) throw new NotFoundException('Target team not found.');
      if (broad) return;
      if (manager && me.team) {
        if (team.departmentId === me.team.departmentId) return;
      } else if (me.teamId === t.teamId) {
        return;
      }
      throw new ForbiddenException('That team is outside your scope.');
    }
  }
}
