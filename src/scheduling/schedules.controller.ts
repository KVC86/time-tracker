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
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEventsPublisher } from '../time-tracking/time-tracking.gateway';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

interface ApplyBody {
  employeeId?: string;
  employeeIds?: string[];     // a specific handful of people sharing one shift
  teamId?: string;
  startDate: string;          // YYYY-MM-DD
  endDate: string;            // YYYY-MM-DD
  startTime?: string;         // HH:mm (required if any working day)
  endTime?: string;           // HH:mm
  isNightShift?: boolean;
  restDays?: string[];        // YYYY-MM-DD dates within the range
  otStartTime?: string;       // HH:mm — overtime window (individual only)
  otEndTime?: string;
  force?: boolean;            // bypass compliance warnings after the WFM confirms
}

interface ScheduleRow {
  employeeId: string;
  workDate: Date;
  isRestDay: boolean;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  otStart: Date | null;
  otEnd: Date | null;
  isNightShift: boolean;
}

// Scheduling is a WFM responsibility (and anything above it). WFM may schedule
// ANY role — floor staff through higher management.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('WFM', 'ADMIN')
@Controller('schedules')
export class SchedulesController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  private async orgIdFor(employeeId: string): Promise<string> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { orgId: true },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    return emp.orgId;
  }

  /** Turn pending schedule rows into upsert operations (one per employee/day). */
  private upsertOps(rows: ScheduleRow[]) {
    return rows.map((r) => {
      const data = {
        isRestDay: r.isRestDay,
        scheduledStart: r.scheduledStart,
        scheduledEnd: r.scheduledEnd,
        otStart: r.otStart,
        otEnd: r.otEnd,
        isNightShift: r.isNightShift,
        // Re-applying clears any prior acknowledgment so a fresh OT grant
        // re-surfaces the "you've been given overtime" banner.
        otAcknowledgedAt: null,
      };
      return this.prisma.schedule.upsert({
        where: { employeeId_workDate: { employeeId: r.employeeId, workDate: r.workDate } },
        create: { employeeId: r.employeeId, workDate: r.workDate, ...data },
        update: data,
      });
    });
  }

  /** Push a real-time "WFM gave you overtime" event to each employee whose
   *  applied rows include an overtime window. The clock UI shows a banner. */
  private emitOvertime(rows: ScheduleRow[]) {
    for (const r of rows) {
      if (!r.otStart || !r.otEnd) continue;
      this.events.toEmployee(r.employeeId, {
        type: 'OVERTIME_GRANTED',
        workDate: r.workDate,
        otStart: r.otStart,
        otEnd: r.otEnd,
      });
    }
  }

  /** Evaluate the resulting roster (existing + pending rows) against the org's
   *  labor-compliance policy. Returns human-readable warnings (empty = clean). */
  private async checkCompliance(orgId: string, newRows: ScheduleRow[]): Promise<string[]> {
    const policy = await this.prisma.shiftPolicy.findFirst({
      where: { orgId },
      orderBy: { createdAt: 'asc' },
    });
    if (!policy || !newRows.length) return [];

    const DAY = 86_400_000;
    const HOUR = 3_600_000;
    const empIds = [...new Set(newRows.map((r) => r.employeeId))];
    const times = newRows.map((r) => r.workDate.getTime());
    const windowStart = Math.min(...times) - 6 * DAY;
    const windowEnd = Math.max(...times) + 6 * DAY;

    const existing = await this.prisma.schedule.findMany({
      where: {
        employeeId: { in: empIds },
        workDate: { gte: new Date(windowStart), lte: new Date(windowEnd) },
      },
    });
    const emps = await this.prisma.employee.findMany({
      where: { id: { in: empIds } },
      select: { id: true, employeeCode: true, fullName: true },
    });
    const nameById = new Map(emps.map((e) => [e.id, `${e.employeeCode} ${e.fullName}`]));

    const key = (d: Date) => d.toISOString().slice(0, 10);
    const byEmp = new Map<string, Map<string, any>>();
    const put = (r: any) => {
      if (!byEmp.has(r.employeeId)) byEmp.set(r.employeeId, new Map());
      byEmp.get(r.employeeId)!.set(key(r.workDate), r);
    };
    existing.forEach(put);
    newRows.forEach(put); // pending rows override existing for the same day

    const isWork = (r: any) => r && !r.isRestDay && r.scheduledStart && r.scheduledEnd;
    const shiftH = (r: any) => (isWork(r) ? (r.scheduledEnd.getTime() - r.scheduledStart.getTime()) / HOUR : 0);
    const otH = (r: any) => (r && r.otStart && r.otEnd ? (r.otEnd.getTime() - r.otStart.getTime()) / HOUR : 0);
    const totalH = (r: any) => shiftH(r) + otH(r);
    const round1 = (n: number) => Math.round(n * 10) / 10;

    const warnings: string[] = [];
    for (const eid of empIds) {
      const map = byEmp.get(eid) ?? new Map();
      const name = nameById.get(eid) ?? 'Employee';

      // a) minimum rest between consecutive shifts
      const workRows = [...map.values()]
        .filter(isWork)
        .sort((a, b) => a.scheduledStart.getTime() - b.scheduledStart.getTime());
      for (let i = 1; i < workRows.length; i++) {
        const rest = (workRows[i].scheduledStart.getTime() - workRows[i - 1].scheduledEnd.getTime()) / HOUR;
        if (rest < policy.minRestHours) {
          warnings.push(`${name}: only ${round1(rest)}h rest before the ${key(workRows[i].workDate)} shift (min ${policy.minRestHours}h).`);
          break;
        }
      }

      // b) maximum consecutive workdays
      let run = 0, runStart = 0, maxRun = 0, maxStart = 0, maxEnd = 0;
      for (let t = windowStart; t <= windowEnd; t += DAY) {
        if (isWork(map.get(key(new Date(t))))) {
          if (run === 0) runStart = t;
          run++;
          if (run > maxRun) { maxRun = run; maxStart = runStart; maxEnd = t; }
        } else run = 0;
      }
      if (maxRun > policy.maxConsecutiveDays) {
        warnings.push(`${name}: ${maxRun} consecutive workdays (${key(new Date(maxStart))}–${key(new Date(maxEnd))}); max is ${policy.maxConsecutiveDays}.`);
      }

      // c/d) weekly-hours cap and overtime threshold (max over any 7-day window)
      let maxWeek = 0, maxWeekStart = 0;
      for (let t = windowStart; t <= windowEnd - 6 * DAY; t += DAY) {
        let sum = 0;
        for (let k = 0; k < 7; k++) sum += totalH(map.get(key(new Date(t + k * DAY))));
        if (sum > maxWeek) { maxWeek = sum; maxWeekStart = t; }
      }
      if (maxWeek > policy.maxWeeklyHours) {
        warnings.push(`${name}: ${round1(maxWeek)}h in the week of ${key(new Date(maxWeekStart))} exceeds the ${policy.maxWeeklyHours}h cap.`);
      } else if (maxWeek > policy.otWeeklyThresholdHours) {
        warnings.push(`${name}: ${round1(maxWeek)}h in the week of ${key(new Date(maxWeekStart))} is over the ${policy.otWeeklyThresholdHours}h overtime threshold.`);
      }

      // e) per-shift length vs the standard shift — warn if a day being
      //    applied is UNDER 8h or OVER 8h. Only checks the rows in this apply
      //    (not the whole roster), since shift length is a property of the
      //    specific day the WFM is setting. Summarized to avoid flooding.
      const myNew = newRows.filter((r) => r.employeeId === eid && isWork(r));
      let underN = 0, overN = 0, underEx = '', overEx = '';
      for (const r of myNew) {
        const h = shiftH(r);
        if (h < policy.shiftHours) { underN++; if (!underEx) underEx = `${key(r.workDate)} at ${round1(h)}h`; }
        else if (h > policy.shiftHours) { overN++; if (!overEx) overEx = `${key(r.workDate)} at ${round1(h)}h`; }
      }
      if (underN)
        warnings.push(`${name}: ${underN} shift${underN > 1 ? 's' : ''} under the standard ${policy.shiftHours}h (e.g. ${underEx}).`);
      if (overN)
        warnings.push(`${name}: ${overN} shift${overN > 1 ? 's' : ''} over ${policy.shiftHours}h (e.g. ${overEx}) — consider the overtime window instead.`);
    }

    return warnings;
  }

  /** Everyone WFM may schedule (all roles) + the teams they can target. */
  @Get('targets')
  async targets(@Req() req: AuthedReq) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    const [employees, teams] = await Promise.all([
      this.prisma.employee.findMany({
        where: { orgId, active: true },
        select: {
          id: true,
          employeeCode: true,
          fullName: true,
          user: { select: { roles: true } },
        },
        orderBy: { employeeCode: 'asc' },
      }),
      this.prisma.team.findMany({
        where: { department: { orgId } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return {
      employees: employees.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        roles: e.user?.roles ?? [],
      })),
      teams,
    };
  }

  /** List schedules — by date (whole org) and/or by employee. */
  @Get()
  async list(
    @Req() req: AuthedReq,
    @Query('date') date?: string,
    @Query('employeeId') employeeId?: string,
  ) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    const where: any = { employee: { orgId } };
    if (employeeId) where.employeeId = employeeId;
    if (date) {
      const d = new Date(date);
      if (isNaN(d.getTime())) throw new BadRequestException('Invalid date.');
      where.workDate = d;
    }
    return this.prisma.schedule.findMany({
      where,
      orderBy: [{ workDate: 'asc' }, { scheduledStart: 'asc' }],
      select: {
        id: true,
        workDate: true,
        scheduledStart: true,
        scheduledEnd: true,
        otStart: true,
        otEnd: true,
        isRestDay: true,
        isNightShift: true,
        employee: { select: { employeeCode: true, fullName: true } },
      },
    });
  }

  /** Apply a shift block across a date range to a team or an individual,
   *  with optional rest days. Upserts one row per employee per day. */
  @Post('apply')
  async apply(@Req() req: AuthedReq, @Body() body: ApplyBody) {
    const { employeeId, teamId, startDate, endDate, startTime, endTime } = body;
    const pickedIds = (body.employeeIds ?? []).filter(Boolean);
    const sources = [employeeId ? 1 : 0, teamId ? 1 : 0, pickedIds.length ? 1 : 0].reduce((a, b) => a + b, 0);
    if (sources !== 1)
      throw new BadRequestException('Provide exactly one of employeeId, employeeIds, or teamId.');
    if (!startDate || !endDate)
      throw new BadRequestException('startDate and endDate are required.');

    const startD = new Date(`${startDate}T00:00:00Z`);
    const endD = new Date(`${endDate}T00:00:00Z`);
    if (isNaN(startD.getTime()) || isNaN(endD.getTime()))
      throw new BadRequestException('Invalid date.');
    if (endD < startD)
      throw new BadRequestException('endDate must be on or after startDate.');

    // Expand the inclusive day range (UTC, so the calendar date is stable).
    const days: string[] = [];
    for (let t = startD.getTime(); t <= endD.getTime(); t += 86_400_000) {
      days.push(new Date(t).toISOString().slice(0, 10));
    }
    if (days.length > 366)
      throw new BadRequestException('Range too large (max 366 days).');

    const restSet = new Set(body.restDays ?? []);
    const hasWorkingDay = days.some((d) => !restSet.has(d));
    if (hasWorkingDay && (!startTime || !endTime))
      throw new BadRequestException('startTime and endTime are required for working days.');

    // Overtime is an individual-only setting. Ignore it for team applies.
    const wantsOt = !!employeeId && !!body.otStartTime && !!body.otEndTime;
    if (employeeId && (body.otStartTime || body.otEndTime) && !wantsOt)
      throw new BadRequestException('Provide both an overtime start and end time, or neither.');

    const orgId = await this.orgIdFor(req.user.employeeId);

    // Resolve target employees (in-org).
    let employeeIds: string[];
    if (employeeId || pickedIds.length) {
      const ids = employeeId ? [employeeId] : pickedIds;
      const found = await this.prisma.employee.findMany({
        where: { id: { in: ids }, orgId },
        select: { id: true },
      });
      if (found.length !== ids.length)
        throw new NotFoundException('One or more selected employees were not found.');
      employeeIds = found.map((e) => e.id);
    } else {
      const team = await this.prisma.team.findUnique({
        where: { id: teamId },
        include: { department: true },
      });
      if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');
      const members = await this.prisma.employee.findMany({
        where: { teamId, active: true },
        select: { id: true },
      });
      employeeIds = members.map((m) => m.id);
      if (!employeeIds.length) throw new BadRequestException('That team has no active members.');
    }

    // Build the pending rows (data only) so we can compliance-check before writing.
    const newRows: ScheduleRow[] = [];
    for (const eid of employeeIds) {
      for (const ds of days) {
        const workDate = new Date(ds); // UTC midnight, matches list queries
        if (restSet.has(ds)) {
          newRows.push({ employeeId: eid, workDate, isRestDay: true, scheduledStart: null, scheduledEnd: null, otStart: null, otEnd: null, isNightShift: false });
        } else {
          const start = new Date(`${ds}T${startTime}:00`);
          let end = new Date(`${ds}T${endTime}:00`);
          if (isNaN(start.getTime()) || isNaN(end.getTime()))
            throw new BadRequestException('Invalid start or end time.');
          if (end <= start) end = new Date(end.getTime() + 86_400_000); // overnight

          // Optional overtime window (individual only). Null when not set, so
          // re-applying without OT clears any previous OT on that day.
          let otStart: Date | null = null;
          let otEnd: Date | null = null;
          if (wantsOt) {
            otStart = new Date(`${ds}T${body.otStartTime}:00`);
            otEnd = new Date(`${ds}T${body.otEndTime}:00`);
            if (isNaN(otStart.getTime()) || isNaN(otEnd.getTime()))
              throw new BadRequestException('Invalid overtime time.');
            if (otEnd <= otStart) otEnd = new Date(otEnd.getTime() + 86_400_000);
          }

          newRows.push({ employeeId: eid, workDate, isRestDay: false, scheduledStart: start, scheduledEnd: end, otStart, otEnd, isNightShift: !!body.isNightShift });
        }
      }
    }

    const summary = {
      employees: employeeIds.length,
      days: days.length,
      restDays: days.filter((d) => restSet.has(d)).length,
      total: newRows.length,
    };

    // Compliance guardrails — return warnings instead of writing, unless confirmed.
    if (!body.force) {
      const warnings = await this.checkCompliance(orgId, newRows);
      if (warnings.length)
        return { ok: false, needsConfirmation: true, warnings, willApply: summary };
    }

    await this.prisma.$transaction(this.upsertOps(newRows));
    this.emitOvertime(newRows);
    return { ok: true, applied: true, ...summary };
  }

  /** Copy a 7-day week of schedules to another week, shifting every entry
   *  (shift times, rest days, and overtime) by the same day offset. */
  @Post('copy-week')
  async copyWeek(
    @Req() req: AuthedReq,
    @Body() body: { sourceStart: string; destStart: string; employeeId?: string; force?: boolean },
  ) {
    const { sourceStart, destStart, employeeId } = body;
    if (!sourceStart || !destStart)
      throw new BadRequestException('sourceStart and destStart are required.');

    const src = new Date(`${sourceStart}T00:00:00Z`);
    const dst = new Date(`${destStart}T00:00:00Z`);
    if (isNaN(src.getTime()) || isNaN(dst.getTime()))
      throw new BadRequestException('Invalid date.');

    const DAY = 86_400_000;
    const offsetMs = dst.getTime() - src.getTime();
    if (offsetMs === 0)
      throw new BadRequestException('Source and destination weeks are the same.');

    const orgId = await this.orgIdFor(req.user.employeeId);
    const srcEnd = new Date(src.getTime() + 6 * DAY);

    const where: any = { employee: { orgId }, workDate: { gte: src, lte: srcEnd } };
    if (employeeId) {
      const emp = await this.prisma.employee.findUnique({
        where: { id: employeeId },
        select: { orgId: true },
      });
      if (!emp || emp.orgId !== orgId) throw new NotFoundException('Employee not found.');
      where.employeeId = employeeId;
    }

    const sources = await this.prisma.schedule.findMany({ where });
    if (!sources.length)
      throw new BadRequestException('No schedules found in the source week.');

    const shift = (d: Date | null) => (d ? new Date(d.getTime() + offsetMs) : null);
    const newRows: ScheduleRow[] = sources.map((s) => ({
      employeeId: s.employeeId,
      workDate: new Date(s.workDate.getTime() + offsetMs),
      isRestDay: s.isRestDay,
      isNightShift: s.isNightShift,
      scheduledStart: shift(s.scheduledStart),
      scheduledEnd: shift(s.scheduledEnd),
      otStart: shift(s.otStart),
      otEnd: shift(s.otEnd),
    }));

    // Same compliance guardrails as a direct apply.
    if (!body.force) {
      const warnings = await this.checkCompliance(orgId, newRows);
      if (warnings.length)
        return { ok: false, needsConfirmation: true, warnings, willApply: { copied: newRows.length } };
    }

    await this.prisma.$transaction(this.upsertOps(newRows));
    this.emitOvertime(newRows);
    return { ok: true, applied: true, copied: newRows.length };
  }

  /** Remove a single schedule entry. */
  @Delete(':id')
  async remove(@Req() req: AuthedReq, @Param('id') id: string) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    const existing = await this.prisma.schedule.findUnique({
      where: { id },
      include: { employee: { select: { orgId: true } } },
    });
    if (!existing || existing.employee.orgId !== orgId)
      throw new NotFoundException('Schedule not found.');
    await this.prisma.schedule.delete({ where: { id } });
    return { ok: true };
  }
}
