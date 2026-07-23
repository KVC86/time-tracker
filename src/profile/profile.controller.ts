import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { ProfilePhotoDto } from './profile.dto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PayslipStatus } from '@prisma/client';
import { classifyOvertime, otClassLabel } from '../common/overtime';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: string[] };
}

// Self-service: anything a signed-in user can do for their own record —
// profile photo, viewing their released payslips, and acknowledging an
// overtime grant. No role check; everything is scoped to req.user.employeeId.
@UseGuards(JwtAuthGuard)
@Controller('me')
export class ProfileController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('photo')
  async setPhoto(@Req() req: AuthedReq, @Body() body: ProfilePhotoDto) {
    if (!req.user.employeeId)
      throw new BadRequestException('No employee record to attach a photo to.');
    const photo = body.photo ?? '';
    if (!photo.startsWith('data:image/'))
      throw new BadRequestException('Photo must be an image data URL.');
    if (photo.length > 2_000_000)
      throw new BadRequestException('Image is too large (max ~1.5 MB).');
    await this.prisma.employee.update({
      where: { id: req.user.employeeId },
      data: { photoUrl: photo },
    });
    return { ok: true };
  }

  // ────────────────────────── MY PAYSLIPS ──────────────────────────────
  // Every member, regardless of role, can view their own RELEASED payslips.

  @Get('payslips')
  async myPayslips(@Req() req: AuthedReq) {
    if (!req.user.employeeId) return [];
    const rows = await this.prisma.payslip.findMany({
      where: { employeeId: req.user.employeeId, status: PayslipStatus.RELEASED },
      orderBy: { periodStart: 'desc' },
      select: {
        id: true,
        periodStart: true,
        periodEnd: true,
        grossPay: true,
        totalAllowances: true,
        totalDeductions: true,
        netPay: true,
        releasedAt: true,
      },
    });
    return rows;
  }

  @Get('payslips/:id')
  async myPayslip(@Req() req: AuthedReq, @Param('id') id: string) {
    const p = await this.prisma.payslip.findUnique({
      where: { id },
      include: { lines: { orderBy: { category: 'asc' } } },
    });
    // Own + released only — never expose a draft or someone else's slip.
    if (!p || p.employeeId !== req.user.employeeId || p.status !== PayslipStatus.RELEASED)
      throw new NotFoundException('Payslip not found.');
    return {
      id: p.id,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      regularHours: p.regularHours,
      overtimeHours: p.overtimeHours,
      nightHours: p.nightHours,
      grossPay: p.grossPay,
      totalAllowances: p.totalAllowances,
      totalDeductions: p.totalDeductions,
      netPay: p.netPay,
      releasedAt: p.releasedAt,
      lines: p.lines.map((l) => ({ category: l.category, label: l.label, amount: l.amount })),
    };
  }

  // ───────────────────────── MY OVERTIME ───────────────────────────────
  // Unacknowledged overtime grants → the "WFM gave you overtime" banner.

  @Get('overtime')
  async myOvertime(@Req() req: AuthedReq) {
    if (!req.user.employeeId) return [];
    const since = new Date();
    since.setDate(since.getDate() - 1); // include yesterday so a just-ended OT still shows
    const rows = await this.prisma.schedule.findMany({
      where: {
        employeeId: req.user.employeeId,
        otStart: { not: null },
        otAcknowledgedAt: null,
        workDate: { gte: this.utcMidnight(since) },
      },
      orderBy: { workDate: 'asc' },
      select: { id: true, workDate: true, otStart: true, otEnd: true, isNightShift: true, isRestDay: true },
    });
    return rows.map((r) => ({
      ...r,
      classification: otClassLabel(classifyOvertime(r.otStart, r.otEnd, r.isRestDay)),
    }));
  }

  @Post('overtime/:scheduleId/ack')
  async ackOvertime(@Req() req: AuthedReq, @Param('scheduleId') scheduleId: string) {
    const sched = await this.prisma.schedule.findUnique({ where: { id: scheduleId } });
    if (!sched || sched.employeeId !== req.user.employeeId)
      throw new NotFoundException('Schedule not found.');
    await this.prisma.schedule.update({
      where: { id: scheduleId },
      data: { otAcknowledgedAt: new Date() },
    });
    return { ok: true };
  }

  // ───────────────────────── MY SCHEDULE ───────────────────────────────
  // Read-only view of the signed-in employee's own upcoming shifts, so they
  // can always look up their hours and overtime window — even after they've
  // dismissed the overtime banner. Self-scoped; no role check.

  @Get('schedule')
  async mySchedule(@Req() req: AuthedReq) {
    if (!req.user.employeeId) return [];
    const since = new Date();
    since.setDate(since.getDate() - 1); // include yesterday so today's shift still shows
    const rows = await this.prisma.schedule.findMany({
      where: {
        employeeId: req.user.employeeId,
        workDate: { gte: this.utcMidnight(since) },
      },
      orderBy: { workDate: 'asc' },
      take: 60, // a reasonable look-ahead horizon
      select: {
        id: true,
        workDate: true,
        isRestDay: true,
        scheduledStart: true,
        scheduledEnd: true,
        otStart: true,
        otEnd: true,
        isNightShift: true,
        otAcknowledgedAt: true,
      },
    });
    // Surface acknowledgement as a boolean; keep the raw timestamp internal.
    return rows.map((r) => ({
      id: r.id,
      workDate: r.workDate,
      isRestDay: r.isRestDay,
      scheduledStart: r.scheduledStart,
      scheduledEnd: r.scheduledEnd,
      otStart: r.otStart,
      otEnd: r.otEnd,
      isNightShift: r.isNightShift,
      hasOvertime: !!(r.otStart && r.otEnd),
      otClass: otClassLabel(classifyOvertime(r.otStart, r.otEnd, r.isRestDay)),
      otAcknowledged: !!r.otAcknowledgedAt,
    }));
  }

  private utcMidnight(d: Date) {
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  }
}
