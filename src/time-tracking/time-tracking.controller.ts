// =====================================================================
//  TimeTrackingController  +  ApprovalsController
//
//  REST surface for the employee clock and the Team Lead console.
//  Auth: JWT (stateless → horizontally scalable). RBAC via a RolesGuard.
//  Every write is server-authoritative; the client sends intent only,
//  never timestamps or computed state.
// =====================================================================

import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import { TimeTrackingService } from './time-tracking.service';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEventsPublisher } from './time-tracking.gateway';
import { ApprovalStatus, BreakType, Role } from '@prisma/client';

// Placeholder guards/decorators — implement in your auth module.
// JwtAuthGuard populates req.user = { userId, employeeId, roles }.
// @Roles(...) + RolesGuard enforce role membership.
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
  ip: string;
}

// ───────────────────────── EMPLOYEE CLOCK ───────────────────────────

@UseGuards(JwtAuthGuard)
@Controller('time')
export class TimeTrackingController {
  constructor(private readonly svc: TimeTrackingService) {}

  @Post('clock-in')
  clockIn(@Req() req: AuthedReq, @Body() body: { activityType: string; source?: string }) {
    return this.svc.clockIn(req.user.employeeId, body.activityType ?? 'Productivity', {
      userId: req.user.userId,
      source: body.source,
      ip: req.ip,
    });
  }

  @Post('activity')
  switchActivity(@Req() req: AuthedReq, @Body() body: { activityType: string }) {
    return this.svc.switchActivity(req.user.employeeId, body.activityType);
  }

  @Post('break/start')
  startBreak(@Req() req: AuthedReq, @Body() body: { breakType: BreakType }) {
    return this.svc.startBreak(req.user.employeeId, body.breakType, req.user.roles);
  }

  @Post('break/end')
  endBreak(@Req() req: AuthedReq) {
    return this.svc.endBreak(req.user.employeeId);
  }

  @Post('logout')
  logout(@Req() req: AuthedReq) {
    return this.svc.logout(req.user.employeeId); // shift keeps running
  }

  @Post('clock-out')
  clockOut(@Req() req: AuthedReq) {
    return this.svc.clockOut(req.user.employeeId); // hard end
  }

  /** Authoritative state for UI hydration on page load / reconnect. */
  @Get('me')
  me(@Req() req: AuthedReq) {
    return this.svc.stateFor(req.user.employeeId);
  }
}

// ───────────────────── TEAM LEAD: APPROVALS ─────────────────────────

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('approvals')
export class ApprovalsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  /** Resolve the employees this user oversees:
   *  WFM/ADMIN → whole org; MANAGER → same department; else → same team. */
  private async supervisedWhere(req: AuthedReq) {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      include: { team: true },
    });
    if (!me) return null;
    if (req.user.roles.includes('WFM') || req.user.roles.includes('ADMIN'))
      return { orgId: me.orgId };
    if (!me.teamId || !me.team) return null;
    return req.user.roles.includes('MANAGER')
      ? { team: { departmentId: me.team.departmentId } }
      : { teamId: me.teamId };
  }

  /** Roster for the additional-bio-break picker. Floor staff only — managers
   *  and team leads have unlimited bio breaks, so they can't be granted more. */
  @Roles('WFM', 'ADMIN')
  @Get('roster')
  async roster(@Req() req: AuthedReq) {
    const where = await this.supervisedWhere(req);
    if (!where) return [];
    const exempt = ['TEAM_LEAD', 'MANAGER', 'WFM', 'HR', 'PAYROLL', 'ADMIN'];
    const emps = await this.prisma.employee.findMany({
      where,
      select: { id: true, employeeCode: true, fullName: true, user: { select: { roles: true } } },
      orderBy: { employeeCode: 'asc' },
    });
    return emps
      .filter((e) => !(e.user?.roles ?? []).some((r) => exempt.includes(r)))
      .map((e) => ({ id: e.id, employeeCode: e.employeeCode, fullName: e.fullName }));
  }

  /** Outstanding (granted, unused) approvals for the team — so the console
   *  can show who currently holds one and offer to revoke it. */
  @Roles('WFM', 'ADMIN')
  @Get('active')
  async active(@Req() req: AuthedReq) {
    const where = await this.supervisedWhere(req);
    if (!where) return [];
    return this.prisma.breakApproval.findMany({
      where: { status: ApprovalStatus.GRANTED, employee: where as any },
      include: { employee: { select: { employeeCode: true, fullName: true } } },
      orderBy: { grantedAt: 'desc' },
    });
  }

  /** Ports grantApproval(): TL/Manager grants an Additional Bio Break.
   *  Pushes a real-time event so the employee's button appears instantly. */
  @Roles('WFM', 'ADMIN')
  @Post()
  async grant(@Req() req: AuthedReq, @Body() body: { employeeId: string }) {
    // Reject if a live, unused grant already exists (ports prototype guard).
    const existing = await this.prisma.breakApproval.findFirst({
      where: { employeeId: body.employeeId, status: ApprovalStatus.GRANTED },
    });
    if (existing) {
      return { ok: false, reason: 'An active unused approval already exists.' };
    }

    const approval = await this.prisma.breakApproval.create({
      data: { employeeId: body.employeeId, grantedById: req.user.employeeId },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: req.user.userId,
        action: 'APPROVAL_GRANTED',
        entity: 'BreakApproval',
        entityId: approval.id,
        payload: { employeeId: body.employeeId },
      },
    });

    this.events.toEmployee(body.employeeId, {
      type: 'ADDL_GRANTED',
      approvalId: approval.id,
    });
    const subj = await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { orgId: true } });
    if (subj) this.events.toActivity(subj.orgId, { action: 'APPROVAL_GRANTED' });
    return { ok: true, approval };
  }

  /** Ports revokeApproval(): pull an unused grant; notify the employee. */
  @Roles('WFM', 'ADMIN')
  @Post(':id/revoke')
  async revoke(@Req() req: AuthedReq, @Param('id') id: string) {
    const approval = await this.prisma.breakApproval.findUnique({ where: { id } });
    if (!approval || approval.status !== ApprovalStatus.GRANTED) {
      return { ok: false, reason: 'No active approval to revoke.' };
    }
    const updated = await this.prisma.breakApproval.update({
      where: { id },
      data: { status: ApprovalStatus.REVOKED, revokedAt: new Date() },
    });
    await this.prisma.auditLog.create({
      data: {
        actorUserId: req.user.userId,
        action: 'APPROVAL_REVOKED',
        entity: 'BreakApproval',
        entityId: id,
        payload: { employeeId: approval.employeeId },
      },
    });
    this.events.toEmployee(approval.employeeId, { type: 'ADDL_REVOKED' });
    const subj = await this.prisma.employee.findUnique({ where: { id: approval.employeeId }, select: { orgId: true } });
    if (subj) this.events.toActivity(subj.orgId, { action: 'APPROVAL_REVOKED' });
    return { ok: true, approval: updated };
  }

  /** Named activity log for the WFM console: who did what to whom.
   *  Covers bio-break grants/revokes and leave approvals/rejections. */
  @Roles('WFM', 'ADMIN')
  @Get('audit')
  async audit() {
    const rows = await this.prisma.auditLog.findMany({
      where: { entity: { in: ['BreakApproval', 'LeaveRequest'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const actorIds = [...new Set(rows.map((r) => r.actorUserId).filter(Boolean) as string[])];
    const subjIds = [...new Set(rows.map((r) => (r.payload as any)?.employeeId).filter(Boolean) as string[])];
    const [actors, subjects] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: actorIds } },
        select: { id: true, roles: true, employee: { select: { fullName: true } } },
      }),
      this.prisma.employee.findMany({ where: { id: { in: subjIds } }, select: { id: true, fullName: true } }),
    ]);
    const actorMap = new Map(actors.map((a) => [a.id, a]));
    const subjMap = new Map(subjects.map((s) => [s.id, s.fullName]));
    return rows.map((r) => {
      const a = r.actorUserId ? actorMap.get(r.actorUserId) : undefined;
      const p = (r.payload as any) || {};
      return {
        at: r.createdAt,
        action: r.action,
        actorName: a?.employee?.fullName ?? 'System',
        actorRole: a?.roles?.[0] ?? '',
        subjectName: subjMap.get(p.employeeId) ?? '',
        leaveType: p.leaveType ?? null,
      };
    });
  }

  /** Recent compliance violations across the WFM's scope (org-wide for WFM). */
  @Roles('WFM', 'ADMIN')
  @Get('violations')
  async violations(@Req() req: AuthedReq) {
    const where = await this.supervisedWhere(req);
    if (!where) return [];
    const rows = await this.prisma.complianceViolation.findMany({
      where: { employee: where as any },
      orderBy: { occurredAt: 'desc' },
      take: 50,
      include: { employee: { select: { employeeCode: true, fullName: true } } },
    });
    return rows.map((v) => ({
      id: v.id,
      type: v.type,
      detail: v.detail,
      occurredAt: v.occurredAt,
      employeeCode: v.employee.employeeCode,
      fullName: v.employee.fullName,
    }));
  }
}
