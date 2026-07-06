// =====================================================================
//  TimeTrackingService
//  Server-authoritative port of the prototype's clock + break rules.
//  Every decision here uses SERVER time and the team's ShiftPolicy.
// =====================================================================

import {
  Injectable,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { manilaStartOfDay, manilaWorkDate, manilaTimeLabel } from '../common/timezone';
import { BreakEnforcementService } from './break-enforcement.service';
import { TimeEventsPublisher } from './time-tracking.gateway';
import {
  BreakType,
  ApprovalStatus,
  TimeEntryStatus,
  ViolationType,
  Prisma,
  Role,
} from '@prisma/client';

interface Ctx {
  userId: string;
  source?: string;
  ip?: string;
}

@Injectable()
export class TimeTrackingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enforcement: BreakEnforcementService,
    private readonly events: TimeEventsPublisher,
  ) {}

  // ─────────────────────────── helpers ──────────────────────────────

  private async getPolicy(employeeId: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { team: { include: { policy: true } }, org: true },
    });
    if (!emp) throw new NotFoundException('Employee not found');

    // team override → else org default
    const policy =
      emp.team?.policy ??
      (await this.prisma.shiftPolicy.findFirst({
        where: { orgId: emp.orgId },
        orderBy: { createdAt: 'asc' },
      }));
    if (!policy) throw new NotFoundException('No shift policy configured');
    return { emp, policy };
  }

  private async openEntry(employeeId: string) {
    return this.prisma.timeEntry.findFirst({
      where: { employeeId, status: TimeEntryStatus.OPEN },
      include: {
        breaks: { where: { endedAt: null } },
      },
    });
  }

  /** Counts breaks already used this shift, mirroring regBreakUsed / bioCount. */
  private async breakTally(timeEntryId: string) {
    const rows = await this.prisma.breakEntry.groupBy({
      by: ['breakType'],
      where: { timeEntryId },
      _count: { _all: true },
    });
    const tally: Record<BreakType, number> = {
      REGULAR: 0,
      BIO: 0,
      ADDITIONAL: 0,
    };
    for (const r of rows) tally[r.breakType] = r._count._all;
    return tally;
  }

  private async audit(action: string, entity: string, entityId: string, payload?: any) {
    await this.prisma.auditLog.create({
      data: { action, entity, entityId, payload },
    });
  }

  // ─────────────────────────── CLOCK IN ─────────────────────────────
  // Ports startWork(): schedule-window check, idempotent resume, 8h window.

  async clockIn(employeeId: string, activityType: string, ctx: Ctx) {
    const { policy } = await this.getPolicy(employeeId);

    // Idempotent: an open shift means "resume", never a second clock-in.
    const existing = await this.openEntry(employeeId);
    if (existing) {
      await this.startActivity(existing.id, activityType);
      return this.stateFor(employeeId);
    }

    // Check for a closed or auto-closed shift from today (Manila calendar day
    // — the business day, independent of the server's timezone).
    // If found and the 8-hour window hasn't expired, re-open it (continue the timer).
    // This allows employees to accidentally clock out, or be auto-logged out by the system,
    // and resume within the same 8-hour shift window, preserving break usage and elapsed time.
    const today = manilaStartOfDay();
    const closedToday = await this.prisma.timeEntry.findFirst({
      where: {
        employeeId,
        clockInAt: { gte: today },
        status: { in: [TimeEntryStatus.CLOSED, TimeEntryStatus.AUTO_CLOSED] },
      },
      orderBy: { clockInAt: 'desc' },
    });

    if (closedToday) {
      // Shift window has expired: cannot resume.
      if (new Date() > closedToday.shiftEndsAt) {
        throw new ForbiddenException(
          'Your shift window has expired. You cannot resume this shift.',
        );
      }

      // Re-open the shift and restore activity. The original shiftEndsAt persists.
      const entry = await this.prisma.timeEntry.update({
        where: { id: closedToday.id },
        data: {
          status: TimeEntryStatus.OPEN,
          clockOutAt: null,
        },
      });

      await this.startActivity(entry.id, activityType);
      await this.enforcement.scheduleShiftExpiry(entry.id, closedToday.shiftEndsAt);
      await this.audit('CLOCK_IN_RESUME', 'TimeEntry', entry.id, {
        activityType,
        originalClockInAt: closedToday.clockInAt,
      });
      this.events.toEmployee(employeeId, {
        type: 'SHIFT_RESUMED',
        shiftEndsAt: closedToday.shiftEndsAt,
      });

      return this.stateFor(employeeId);
    }

    // No closed shift: start a fresh 8-hour window.
    // Scheduled-login window: honour the WFM-assigned schedule for today.
    // Schedules store workDate as the UTC-midnight of the MANILA calendar
    // date. Deriving "today" from the server's clock would look up the wrong
    // row (and skip enforcement) for any shift between 00:00 and 08:00
    // Manila when the server runs UTC.
    const scheduleDate = manilaWorkDate();
    const sched = await this.prisma.schedule.findFirst({
      where: { employeeId, workDate: scheduleDate },
    });

    // The allowed clock-in window is the assigned shift, WIDENED to include any
    // granted overtime window — so an OT'd employee can log in past their normal
    // end (or before their normal start, if OT sits ahead of the shift). OT is a
    // single contiguous window per day, so the min/max envelope is the union.
    // The grant itself (otStart/otEnd being set) is the authorisation; the
    // banner acknowledgement is a UX dismissal, not a precondition for working.
    const hasOt = !!(sched?.otStart && sched?.otEnd);
    const windowStart = !sched
      ? null
      : hasOt && sched.scheduledStart
        ? new Date(Math.min(sched.scheduledStart.getTime(), sched.otStart!.getTime()))
        : sched.scheduledStart ?? sched.otStart;
    const windowEnd = !sched
      ? null
      : hasOt && sched.scheduledEnd
        ? new Date(Math.max(sched.scheduledEnd.getTime(), sched.otEnd!.getTime()))
        : sched.scheduledEnd ?? sched.otEnd;

    if (sched) {
      // A scheduled rest day means no shift at all today — unless WFM granted
      // overtime for the rest day (an explicit OT call on a day off), which
      // opens the OT window enforced below.
      if (sched.isRestDay && !hasOt) {
        await this.recordViolation(
          employeeId,
          ViolationType.OUT_OF_SCHEDULE_LOGIN,
          'Attempted login on a scheduled rest day',
        );
        throw new ForbiddenException(
          'Today is a scheduled rest day — you cannot clock in.',
        );
      }
      // Before the window opens → block (the explicit requirement).
      if (windowStart && new Date() < windowStart) {
        const startLabel = manilaTimeLabel(windowStart);
        await this.recordViolation(
          employeeId,
          ViolationType.OUT_OF_SCHEDULE_LOGIN,
          `Attempted login before window start ${windowStart.toISOString()}`,
        );
        throw new ForbiddenException(
          `Too early to clock in. Your ${hasOt ? 'shift window (incl. overtime) opens' : 'shift starts'} at ${startLabel}.`,
        );
      }
      // After the window closes → the shift (plus any granted OT) is over.
      if (windowEnd && new Date() > windowEnd) {
        const endLabel = manilaTimeLabel(windowEnd);
        await this.recordViolation(
          employeeId,
          ViolationType.OUT_OF_SCHEDULE_LOGIN,
          `Attempted login after window end ${windowEnd.toISOString()}`,
        );
        throw new ForbiddenException(
          `Your ${hasOt ? 'shift (including overtime)' : 'scheduled shift'} has already ended for today (ended at ${endLabel}).`,
        );
      }
    }

    const now = new Date();
    // Auto-expiry follows the assigned window END — the scheduled end, widened
    // by any granted OT — when a schedule exists; otherwise fall back to the
    // org's default shift-length policy from the moment of clock-in.
    const shiftEndsAt =
      sched && windowEnd
        ? windowEnd
        : new Date(now.getTime() + policy.shiftHours * 3600_000);

    let entry;
    try {
      entry = await this.prisma.timeEntry.create({
        data: {
          employeeId,
          scheduleId: sched?.id,
          clockInAt: now,
          shiftEndsAt,
          status: TimeEntryStatus.OPEN,
          source: ctx.source ?? 'web',
          ipAddress: ctx.ip,
          activities: {
            create: { activityType, startedAt: now },
          },
        },
      });
    } catch (e) {
      // Partial-unique index race: someone clocked in a millisecond earlier.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        await this.startActivity((await this.openEntry(employeeId))!.id, activityType);
        return this.stateFor(employeeId);
      }
      throw e;
    }

    // Schedule the hard 8-hour expiry (replaces the per-second browser check).
    await this.enforcement.scheduleShiftExpiry(entry.id, shiftEndsAt);
    await this.audit('CLOCK_IN', 'TimeEntry', entry.id, { activityType });
    this.events.toEmployee(employeeId, { type: 'SHIFT_STARTED', shiftEndsAt });

    return this.stateFor(employeeId);
  }

  // ───────────────────── SWITCH ACTIVITY ─────────────────────────────

  async switchActivity(employeeId: string, activityType: string) {
    const entry = await this.openEntry(employeeId);
    if (!entry) throw new BadRequestException('No active shift.');
    if (entry.breaks.length)
      throw new BadRequestException('End your break before switching activity.');
    await this.startActivity(entry.id, activityType);
    await this.audit('ACTIVITY_SWITCH', 'TimeEntry', entry.id, { activityType });
    return this.stateFor(employeeId);
  }

  private async startActivity(timeEntryId: string, activityType: string) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.activitySession.updateMany({
        where: { timeEntryId, endedAt: null },
        data: { endedAt: now },
      }),
      this.prisma.activitySession.create({
        data: { timeEntryId, activityType, startedAt: now },
      }),
    ]);
  }

  // ─────────────────────────── START BREAK ───────────────────────────
  // Ports attemptBreak(): the full rule engine, evaluated server-side.
  // Team Leads, Managers, HR, and Admins are exempt from bio break limits.

  async startBreak(employeeId: string, breakType: BreakType, userRoles?: Role[]) {
    const { policy } = await this.getPolicy(employeeId);
    const entry = await this.openEntry(employeeId);
    if (!entry) throw new BadRequestException('No active shift.');

    if (entry.breaks.length)
      throw new ConflictException('You are already on a break. Resume work first.');

    const tally = await this.breakTally(entry.id);
    const elapsedMs = Date.now() - entry.clockInAt.getTime();
    let approvalId: string | undefined;

    // Check if user is exempt from break limits (supervisory roles).
    const isExempt = (userRoles || []).some(r =>
      ['TEAM_LEAD', 'MANAGER', 'HR', 'ADMIN'].includes(r),
    );

    if (breakType === BreakType.REGULAR) {
      if (elapsedMs < policy.regUnlockHours * 3600_000) {
        const remainMin = Math.ceil(
          (policy.regUnlockHours * 3600_000 - elapsedMs) / 60_000,
        );
        await this.recordViolation(
          employeeId,
          ViolationType.EARLY_REGULAR_BREAK,
          'Attempted Regular Break before unlock window',
        );
        throw new ForbiddenException(
          `Regular Break unlocks after ${policy.regUnlockHours}h (${remainMin} min remaining).`,
        );
      }
      if (tally.REGULAR >= policy.regPerShift) {
        await this.recordViolation(
          employeeId,
          ViolationType.SECOND_REGULAR_BREAK,
          'Attempted a second Regular Break',
        );
        throw new ConflictException('Regular Break already used this shift.');
      }
    }

    if (breakType === BreakType.BIO) {
      // Bio break limits only apply to regular employees, not supervisors.
      if (!isExempt && tally.BIO >= policy.bioPerShift) {
        await this.recordViolation(
          employeeId,
          ViolationType.BIO_LIMIT_EXCEEDED,
          `Attempted Bio Break beyond max (${policy.bioPerShift})`,
        );
        throw new ConflictException(
          `Maximum of ${policy.bioPerShift} Bio Breaks reached.`,
        );
      }
    }

    if (breakType === BreakType.ADDITIONAL) {
      // Management roles are not eligible for additional bio breaks.
      if (isExempt) {
        throw new ForbiddenException(
          'Additional bio breaks are not available for management roles.',
        );
      }
      const approval = await this.prisma.breakApproval.findFirst({
        where: { employeeId, status: ApprovalStatus.GRANTED },
        orderBy: { grantedAt: 'desc' },
      });
      if (!approval) {
        await this.recordViolation(
          employeeId,
          ViolationType.ADDL_UNAPPROVED,
          'Attempted Additional Bio Break without approval',
        );
        throw new ForbiddenException(
          'Additional Bio Break requires Team Lead approval.',
        );
      }
      approvalId = approval.id;
    }

    const maxSeconds =
      breakType === BreakType.REGULAR
        ? policy.regMaxSeconds
        : breakType === BreakType.BIO
        ? policy.bioMaxSeconds
        : policy.addlMaxSeconds;

    const now = new Date();
    const deadlineAt = new Date(
      now.getTime() + (maxSeconds + policy.graceSeconds) * 1000,
    );

    const brk = await this.prisma.$transaction(async (tx) => {
      // close current activity session (employee is now on break)
      await tx.activitySession.updateMany({
        where: { timeEntryId: entry.id, endedAt: null },
        data: { endedAt: now },
      });
      const created = await tx.breakEntry.create({
        data: {
          timeEntryId: entry.id,
          breakType,
          startedAt: now,
          deadlineAt,
          approvalId,
        },
      });
      if (approvalId) {
        await tx.breakApproval.update({
          where: { id: approvalId },
          data: { status: ApprovalStatus.CONSUMED, consumedAt: now },
        });
      }
      return created;
    });

    // Schedule the hard deadline (the O(1)-per-break scale mechanism).
    await this.enforcement.scheduleBreakDeadline(brk.id, deadlineAt);
    await this.audit('BREAK_START', 'BreakEntry', brk.id, { breakType });
    this.events.toEmployee(employeeId, {
      type: 'BREAK_STARTED',
      breakType,
      deadlineAt,
    });
    if (approvalId) {
      this.events.toApprovers(employeeId, { type: 'ADDL_CONSUMED', employeeId });
    }
    return this.stateFor(employeeId);
  }

  // ─────────────────────────── END BREAK ─────────────────────────────
  // Ports resumeWork(): close break, cancel its deadline job, resume work.

  async endBreak(employeeId: string) {
    const entry = await this.openEntry(employeeId);
    if (!entry) throw new BadRequestException('No active shift.');
    const open = entry.breaks[0];
    if (!open) throw new BadRequestException('You are not on a break.');

    // Resume the activity the employee was on before the break. No activity
    // session is open during a break, so the most recent one is the pre-break
    // activity; fall back to Productivity only if there genuinely isn't one.
    const prior = await this.prisma.activitySession.findFirst({
      where: { timeEntryId: entry.id },
      orderBy: { startedAt: 'desc' },
      select: { activityType: true },
    });
    const resumeType = prior?.activityType ?? 'Productivity';

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.breakEntry.update({
        where: { id: open.id },
        data: { endedAt: now },
      }),
      this.prisma.activitySession.create({
        data: { timeEntryId: entry.id, activityType: resumeType, startedAt: now },
      }),
    ]);

    await this.enforcement.cancelBreakDeadline(open.id);
    await this.audit('BREAK_END', 'BreakEntry', open.id);
    this.events.toEmployee(employeeId, { type: 'BREAK_ENDED' });
    return this.stateFor(employeeId);
  }

  // ─────────────────── LOGOUT (shift keeps running) ──────────────────
  // Ports confirmLogout(): close the activity session, keep the window OPEN.

  async logout(employeeId: string) {
    const entry = await this.openEntry(employeeId);
    if (!entry) return this.stateFor(employeeId);
    await this.prisma.activitySession.updateMany({
      where: { timeEntryId: entry.id, endedAt: null },
      data: { endedAt: new Date() },
    });
    await this.audit('LOGOUT_BACKGROUND', 'TimeEntry', entry.id);
    this.events.toEmployee(employeeId, { type: 'LOGGED_OUT_BACKGROUND' });
    return this.stateFor(employeeId);
  }

  // ─────────────────────────── CLOCK OUT ─────────────────────────────
  // Explicit hard end (distinct from background logout).

  async clockOut(employeeId: string) {
    const entry = await this.openEntry(employeeId);
    if (!entry) throw new BadRequestException('No active shift.');
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.activitySession.updateMany({
        where: { timeEntryId: entry.id, endedAt: null },
        data: { endedAt: now },
      }),
      this.prisma.timeEntry.update({
        where: { id: entry.id },
        data: { status: TimeEntryStatus.CLOSED, clockOutAt: now },
      }),
    ]);
    await this.enforcement.cancelShiftExpiry(entry.id);
    await this.audit('CLOCK_OUT', 'TimeEntry', entry.id);
    this.events.toEmployee(employeeId, { type: 'CLOCKED_OUT' });
    return this.stateFor(employeeId);
  }

  // ───────────────── AUTHORITATIVE STATE (for UI hydration) ───────────

  async stateFor(employeeId: string) {
    const { policy } = await this.getPolicy(employeeId);
    const entry = await this.openEntry(employeeId);
    if (!entry) return { loggedIn: false, onShift: false, policy };

    const tally = await this.breakTally(entry.id);
    const currentActivity = await this.prisma.activitySession.findFirst({
      where: { timeEntryId: entry.id, endedAt: null },
      orderBy: { startedAt: 'desc' },
    });
    const currentBreak = entry.breaks[0] ?? null;
    const approval = await this.prisma.breakApproval.findFirst({
      where: { employeeId, status: ApprovalStatus.GRANTED },
    });

    const elapsedMs = Date.now() - entry.clockInAt.getTime();
    return {
      onShift: true,
      loggedIn: !!currentActivity && !currentBreak,
      clockInAt: entry.clockInAt,
      shiftEndsAt: entry.shiftEndsAt,
      elapsedMs,
      currentActivity: currentActivity?.activityType ?? null,
      currentBreak: currentBreak
        ? { type: currentBreak.breakType, deadlineAt: currentBreak.deadlineAt }
        : null,
      regBreakUsed: tally.REGULAR >= policy.regPerShift,
      regUnlocked: elapsedMs >= policy.regUnlockHours * 3600_000,
      bioUsed: tally.BIO,
      bioMax: policy.bioPerShift,
      additionalApproved: !!approval,
      policy,
    };
  }

  // ─────────────────────────── internals ─────────────────────────────

  private async recordViolation(employeeId: string, type: ViolationType, detail: string) {
    await this.prisma.complianceViolation.create({
      data: { employeeId, type, detail },
    });
    this.events.toApprovers(employeeId, { type: 'VIOLATION', violation: type, detail, employeeId });
    const emp = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { orgId: true } });
    if (emp) this.events.toActivity(emp.orgId, { action: 'VIOLATION' });
  }

}
