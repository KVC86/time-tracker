import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { LeaveStatus, LeaveType, Role } from '@prisma/client';
import { TimeEventsPublisher } from '../time-tracking/time-tracking.gateway';

// Leave pay policy: Vacation is the only PAID leave; Sick, Emergency and
// Birthday are unpaid. Payroll pays for worked time only, so this is a
// classification surfaced to users — it deliberately does not change any pay
// computation.
const PAID_LEAVE_TYPES = new Set<LeaveType>([LeaveType.VACATION]);
const isPaidLeave = (t: LeaveType) => PAID_LEAVE_TYPES.has(t);

// Advance-notice policy: only Vacation requires advance notice (≥3 days). Sick,
// Emergency and Birthday leave may be filed at any time, including the same day.
const ADVANCE_NOTICE_LEAVE_TYPES = new Set<LeaveType>([LeaveType.VACATION]);

// Supporting images (proof of absence) are accepted only for these types.
const SUPPORTING_DOC_LEAVE_TYPES = new Set<LeaveType>([LeaveType.SICK, LeaveType.EMERGENCY]);
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_LEN = 3_000_000; // ~2 MB as a base64 data URL

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

@UseGuards(JwtAuthGuard)
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  /** Employee submits a leave request. */
  @Post()
  async submit(@Req() req: AuthedReq, @Body() body: { leaveType: LeaveType; startDate: string; endDate: string; reason?: string; attachments?: string[] }) {
    if (!body.leaveType || !body.startDate || !body.endDate)
      throw new BadRequestException('leaveType, startDate, and endDate are required.');

    const start = new Date(body.startDate);
    const end   = new Date(body.endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      throw new BadRequestException('Invalid date format.');
    if (end < start)
      throw new BadRequestException('endDate must be on or after startDate.');

    // Advance-notice policy. Sick and Emergency leave may start any time,
    // including today (same-day filing). Vacation and Birthday leave still
    // require at least 3 days' notice. In every case a start date in the past
    // is rejected.
    const needsNotice = ADVANCE_NOTICE_LEAVE_TYPES.has(body.leaveType);
    const earliest = new Date();
    earliest.setHours(0, 0, 0, 0);
    earliest.setDate(earliest.getDate() + (needsNotice ? 3 : 0));
    const earliestStr = `${earliest.getFullYear()}-${String(earliest.getMonth() + 1).padStart(2, '0')}-${String(earliest.getDate()).padStart(2, '0')}`;
    if (body.startDate < earliestStr)
      throw new BadRequestException(
        needsNotice
          ? `Vacation leave must be requested at least 3 days in advance. The earliest date you can request is ${earliestStr}.`
          : `Leave cannot start in the past. The earliest date you can request is ${earliestStr}.`,
      );

    // Supporting images (proof of absence) — accepted only for Sick/Emergency.
    // For any other type the field is ignored, so nothing else is affected.
    const rawAttachments = Array.isArray(body.attachments) ? body.attachments : [];
    const attachments = SUPPORTING_DOC_LEAVE_TYPES.has(body.leaveType) ? rawAttachments : [];
    if (attachments.length > MAX_ATTACHMENTS)
      throw new BadRequestException(`You can attach at most ${MAX_ATTACHMENTS} images.`);
    for (const a of attachments) {
      if (typeof a !== 'string' || !a.startsWith('data:image/'))
        throw new BadRequestException('Each attachment must be an image data URL.');
      if (a.length > MAX_ATTACHMENT_LEN)
        throw new BadRequestException('Each image must be under ~2 MB.');
    }

    // Override: a new request for dates that overlap an existing request from
    // the same employee replaces the former one(s). Two ranges overlap when
    // existing.start <= new.end AND existing.end >= new.start.
    const { created, overrode } = await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.leaveRequest.deleteMany({
        where: {
          employeeId: req.user.employeeId,
          startDate: { lte: end },
          endDate: { gte: start },
        },
      });
      const created = await tx.leaveRequest.create({
        data: {
          employeeId: req.user.employeeId,
          leaveType:  body.leaveType,
          startDate:  start,
          endDate:    end,
          reason:     body.reason?.trim() || null,
          attachments,
        },
        select: { id: true, leaveType: true, startDate: true, endDate: true, status: true, submittedAt: true, attachments: true },
      });
      return { created, overrode: count };
    });

    return { ...created, paid: isPaidLeave(created.leaveType), overrode };
  }

  /** Employee views their own leave requests. */
  @Get('my')
  async myRequests(@Req() req: AuthedReq) {
    const rows = await this.prisma.leaveRequest.findMany({
      where:   { employeeId: req.user.employeeId },
      orderBy: { submittedAt: 'desc' },
      select: {
        id: true, leaveType: true, startDate: true, endDate: true,
        reason: true, status: true, reviewNote: true, submittedAt: true, reviewedAt: true,
        attachments: true,
        reviewedBy: { select: { fullName: true } },
      },
    });
    return rows.map((r) => ({ ...r, paid: isPaidLeave(r.leaveType) }));
  }

  /** Team Lead / Manager views pending requests from their team. */
  @UseGuards(RolesGuard)
  @Roles('TEAM_LEAD', 'HR', 'ADMIN')
  @Get('team')
  async teamRequests(@Req() req: AuthedReq) {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true },
    });
    if (!me) return [];

    // HR/Admin see the whole org; a Team Lead sees only employees on the
    // team(s) they lead. (WFM has no access to the leave window.)
    const broad = req.user.roles.includes('HR' as Role) || req.user.roles.includes('ADMIN' as Role);
    const where = broad
      ? { employee: { orgId: me.orgId } }
      : { employee: { team: { leadId: req.user.employeeId } } };

    const rows = await this.prisma.leaveRequest.findMany({
      where: { ...where, status: LeaveStatus.PENDING },
      orderBy: { submittedAt: 'asc' },
      select: {
        id: true, leaveType: true, startDate: true, endDate: true, reason: true, submittedAt: true,
        attachments: true,
        employee: { select: { employeeCode: true, fullName: true } },
      },
    });

    // Notice lead time: calendar days between submission and leave start.
    // onTime = submitted at least two weeks (14 days) before the start date.
    const DAY = 86_400_000;
    return rows.map((r) => {
      const startUTC = Date.UTC(r.startDate.getUTCFullYear(), r.startDate.getUTCMonth(), r.startDate.getUTCDate());
      const subUTC = Date.UTC(r.submittedAt.getUTCFullYear(), r.submittedAt.getUTCMonth(), r.submittedAt.getUTCDate());
      const noticeDays = Math.round((startUTC - subUTC) / DAY);
      return { ...r, noticeDays, onTime: noticeDays >= 14, paid: isPaidLeave(r.leaveType) };
    });
  }

  /** Team Lead / Manager approves a leave request. */
  @UseGuards(RolesGuard)
  @Roles('TEAM_LEAD', 'HR', 'ADMIN')
  @Post(':id/approve')
  async approve(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: { note?: string }) {
    return this.reviewLeave(req.user, id, LeaveStatus.APPROVED, body.note);
  }

  /** Team Lead / Manager rejects a leave request. */
  @UseGuards(RolesGuard)
  @Roles('TEAM_LEAD', 'HR', 'ADMIN')
  @Post(':id/reject')
  async reject(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: { note?: string }) {
    return this.reviewLeave(req.user, id, LeaveStatus.REJECTED, body.note);
  }

  private async reviewLeave(
    actor: AuthedReq['user'],
    id: string,
    status: LeaveStatus,
    note?: string,
  ) {
    const lr = await this.prisma.leaveRequest.findUnique({
      where: { id },
      include: { employee: { select: { orgId: true, team: { select: { leadId: true } } } } },
    });
    if (!lr) throw new NotFoundException('Leave request not found.');
    if (lr.status !== LeaveStatus.PENDING)
      throw new ForbiddenException('This request has already been reviewed.');

    // Scoped approvals: a Team Lead may only review their own team's leave.
    // HR/Admin can review any. (WFM has no access to the leave window.)
    const broad = actor.roles.includes('HR' as Role) || actor.roles.includes('ADMIN' as Role);
    if (!broad && lr.employee.team?.leadId !== actor.employeeId)
      throw new ForbiddenException('You can only review leave for your own team.');

    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, reviewedById: actor.employeeId, reviewNote: note?.trim() || null, reviewedAt: new Date() },
      select: { id: true, status: true, reviewNote: true, reviewedAt: true },
    });

    // Record it in the WFM activity log + push live.
    await this.prisma.auditLog.create({
      data: {
        actorUserId: actor.userId,
        action: status === LeaveStatus.APPROVED ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
        entity: 'LeaveRequest',
        entityId: id,
        payload: { employeeId: lr.employeeId, leaveType: lr.leaveType },
      },
    });
    this.events.toActivity(lr.employee.orgId, {
      action: status === LeaveStatus.APPROVED ? 'LEAVE_APPROVED' : 'LEAVE_REJECTED',
    });
    return updated;
  }
}
