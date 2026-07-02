// =====================================================================
//  BreakEnforcementService  +  EnforcementWorker
//
//  THE SCALE MECHANISM (README §1b).
//  Replaces the prototype's per-browser setInterval(tick,1000) with
//  DEADLINE-SCHEDULED JOBS so cost is O(overdue events), not O(users).
//
//   - On break start  → schedule one delayed job at the break deadline.
//   - On shift start  → schedule one delayed job at clockInAt + 8h.
//   - When a job fires → re-check the DB; act only if still open.
//   - A 30s reconciliation sweep catches anything Redis dropped.
//
//  At 3,000 concurrent users this holds ~3,000 cheap delayed jobs in
//  Redis with near-zero idle CPU, and survives process restarts because
//  the authoritative deadline lives in PostgreSQL.
// =====================================================================

import { Injectable, OnModuleInit, Logger } from '@nestjs/common';
import { Queue, Worker, JobsOptions } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEventsPublisher } from './time-tracking.gateway';
import { Role, TimeEntryStatus, ViolationType } from '@prisma/client';

const connection = {
  host: process.env.REDIS_HOST ?? '127.0.0.1',
  port: Number(process.env.REDIS_PORT ?? 6379),
};

const QUEUE = 'time-enforcement';

// Privileged roles are exempt from the hard auto-clock-out on break overrun;
// only floor-level employees get clocked out (everyone else just resumes work).
// Exported: the idle-events endpoint applies the same floor-level definition.
export const EXEMPT_ROLES: Role[] = ['TEAM_LEAD', 'WFM', 'MANAGER', 'HR', 'PAYROLL', 'ADMIN'];

type JobData =
  | { kind: 'BREAK_DEADLINE'; breakId: string }
  | { kind: 'SHIFT_EXPIRY'; timeEntryId: string };

@Injectable()
export class BreakEnforcementService {
  private readonly queue = new Queue<JobData>(QUEUE, { connection });

  // Deterministic jobIds let us cancel precisely when a break/shift ends early.
  // NOTE: BullMQ forbids ':' in custom job IDs (it's a Redis key separator) — use '-'.
  private breakJobId = (id: string) => `break-${id}`;
  private shiftJobId = (id: string) => `shift-${id}`;

  private opts(deadline: Date, jobId: string): JobsOptions {
    return {
      jobId,
      delay: Math.max(0, deadline.getTime() - Date.now()),
      removeOnComplete: true,
      removeOnFail: 100,
    };
  }

  async scheduleBreakDeadline(breakId: string, deadlineAt: Date) {
    await this.queue.add(
      'break-deadline',
      { kind: 'BREAK_DEADLINE', breakId },
      this.opts(deadlineAt, this.breakJobId(breakId)),
    );
  }

  async cancelBreakDeadline(breakId: string) {
    await this.queue.remove(this.breakJobId(breakId)).catch(() => void 0);
  }

  async scheduleShiftExpiry(timeEntryId: string, shiftEndsAt: Date) {
    await this.queue.add(
      'shift-expiry',
      { kind: 'SHIFT_EXPIRY', timeEntryId },
      this.opts(shiftEndsAt, this.shiftJobId(timeEntryId)),
    );
  }

  async cancelShiftExpiry(timeEntryId: string) {
    await this.queue.remove(this.shiftJobId(timeEntryId)).catch(() => void 0);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Worker — runs in the worker tier (1+ replicas; BullMQ load-balances).
//  Register this as a NestJS provider with OnModuleInit, or bootstrap it
//  in a dedicated worker process (recommended: separate from the API).
// ─────────────────────────────────────────────────────────────────────

@Injectable()
export class EnforcementWorker implements OnModuleInit {
  private readonly log = new Logger(EnforcementWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  onModuleInit() {
    new Worker<JobData>(
      QUEUE,
      async (job) => {
        if (job.data.kind === 'BREAK_DEADLINE') {
          await this.enforceBreak(job.data.breakId);
        } else {
          await this.expireShift(job.data.timeEntryId);
        }
      },
      // Cap concurrency below the DB connection pool. In dev the API, gateway,
      // worker, and 30s sweep all share one Prisma pool (~13 by default); a
      // 50-wide worker starves it under a job burst, and the sweep then times
      // out fetching a connection (P2024) so overdue breaks never get enforced.
      // Prod runs workers as a separate tier (own pool via PgBouncer) and can
      // raise this via ENFORCEMENT_CONCURRENCY.
      { connection, concurrency: Number(process.env.ENFORCEMENT_CONCURRENCY ?? 10) },
    );

    // Reconciliation sweep — backstop for any job lost to a Redis flush.
    setInterval(() => this.sweep().catch((e) => this.log.error(e)), 30_000);
    this.log.log('Enforcement worker started (deadline jobs + 30s sweep)');
  }

  /** Enforce a break that's still open at its deadline. Floor-level employees
   *  are AUTO-CLOCKED-OUT (shift closed, paid-time tracking stops); privileged
   *  staff just have the break ended and resume work. */
  private async enforceBreak(breakId: string) {
    const brk = await this.prisma.breakEntry.findUnique({
      where: { id: breakId },
      include: { timeEntry: true },
    });
    if (!brk || brk.endedAt) return;                 // already resumed → no-op
    if (brk.timeEntry.status !== TimeEntryStatus.OPEN) return;
    if (Date.now() < brk.deadlineAt.getTime()) return; // clock skew guard

    const now = new Date();
    const employeeId = brk.timeEntry.employeeId;

    // Who is this? Floor-level employees get auto-clocked-out on overrun.
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { user: { select: { roles: true } } },
    });
    const roles = emp?.user?.roles ?? [];
    const isFloorEmployee = !roles.some((r) => EXEMPT_ROLES.includes(r));

    if (isFloorEmployee) {
      // ── AUTO CLOCK-OUT ────────────────────────────────────────────────
      // End the break, close every open activity session, and CLOSE the shift.
      // With the shift CLOSED and no session open, no further paid time accrues
      // — paid-time tracking stops at `now`.
      await this.prisma.$transaction([
        this.prisma.breakEntry.update({
          where: { id: brk.id },
          data: { endedAt: now, exceeded: true },
        }),
        this.prisma.activitySession.updateMany({
          where: { timeEntryId: brk.timeEntryId, endedAt: null },
          data: { endedAt: now },                 // stop paid-time accrual
        }),
        this.prisma.timeEntry.update({
          where: { id: brk.timeEntryId },
          data: { status: TimeEntryStatus.AUTO_CLOSED, clockOutAt: now }, // clock out
        }),
        this.prisma.complianceViolation.create({
          data: {
            employeeId,
            type: ViolationType.BREAK_OVERRUN,
            detail: `${brk.breakType} break exceeded its limit; employee auto-clocked-out.`,
          },
        }),
        this.prisma.auditLog.create({
          data: {
            action: 'BREAK_OVERRUN_AUTO_LOGOUT',
            entity: 'TimeEntry',
            entityId: brk.timeEntryId,
            payload: { breakType: brk.breakType, breakId: brk.id },
          },
        }),
      ]);

      // The pending 8-hour SHIFT_EXPIRY job will simply no-op now that the shift
      // is CLOSED (it checks status === OPEN), so there's nothing to cancel.

      this.events.toEmployee(employeeId, {
        type: 'AUTO_CLOCKED_OUT',
        reason: 'BREAK_OVERRUN',
        breakType: brk.breakType,
      });
      this.events.toApprovers(employeeId, {
        type: 'EMPLOYEE_AUTO_CLOCKED_OUT',
        employeeId,
        breakType: brk.breakType,
      });
      return;
    }

    // ── PRIVILEGED STAFF: end the break and resume their prior activity ──
    // (no session is open during a break, so the most recent one is pre-break).
    const prior = await this.prisma.activitySession.findFirst({
      where: { timeEntryId: brk.timeEntryId },
      orderBy: { startedAt: 'desc' },
      select: { activityType: true },
    });
    const resumeType = prior?.activityType ?? 'Productivity';

    await this.prisma.$transaction([
      this.prisma.breakEntry.update({
        where: { id: brk.id },
        data: { endedAt: now, exceeded: true },
      }),
      this.prisma.activitySession.create({
        data: { timeEntryId: brk.timeEntryId, activityType: resumeType, startedAt: now },
      }),
      this.prisma.complianceViolation.create({
        data: {
          employeeId,
          type: ViolationType.BREAK_OVERRUN,
          detail: `${brk.breakType} break exceeded its limit; break ended automatically and work resumed.`,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          action: 'BREAK_OVERRUN',
          entity: 'BreakEntry',
          entityId: brk.id,
          payload: { breakType: brk.breakType },
        },
      }),
    ]);

    this.events.toEmployee(employeeId, {
      type: 'BREAK_OVERRUN',
      breakType: brk.breakType,
    });
    this.events.toApprovers(employeeId, {
      type: 'EMPLOYEE_BREAK_OVERRUN',
      employeeId,
      breakType: brk.breakType,
    });
  }

  /** Close the shift at the hard 8-hour mark. Ports the prototype's
   *  "eMs >= shiftHours → doLogout(true)" branch. */
  private async expireShift(timeEntryId: string) {
    const entry = await this.prisma.timeEntry.findUnique({
      where: { id: timeEntryId },
    });
    if (!entry || entry.status !== TimeEntryStatus.OPEN) return;
    if (Date.now() < entry.shiftEndsAt.getTime()) return;

    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.activitySession.updateMany({
        where: { timeEntryId, endedAt: null },
        data: { endedAt: now },
      }),
      this.prisma.breakEntry.updateMany({
        where: { timeEntryId, endedAt: null },
        data: { endedAt: now },
      }),
      this.prisma.timeEntry.update({
        where: { id: timeEntryId },
        data: { status: TimeEntryStatus.AUTO_CLOSED, clockOutAt: now },
      }),
      this.prisma.complianceViolation.create({
        data: {
          employeeId: entry.employeeId,
          type: ViolationType.SHIFT_EXPIRED,
          detail: '8-hour shift window expired; auto-closed.',
        },
      }),
    ]);

    this.events.toEmployee(entry.employeeId, {
      type: 'SHIFT_EXPIRED',
    });
  }

  /** Backstop: find open breaks / shifts already past deadline and act.
   *  Uses the partial indexes from schema.prisma, so it's cheap. */
  private async sweep() {
    const now = new Date();

    const overdueBreaks = await this.prisma.breakEntry.findMany({
      where: { endedAt: null, deadlineAt: { lte: now } },
      select: { id: true },
      take: 500,
    });
    for (const b of overdueBreaks) await this.enforceBreak(b.id);

    const expiredShifts = await this.prisma.timeEntry.findMany({
      where: { status: TimeEntryStatus.OPEN, shiftEndsAt: { lte: now } },
      select: { id: true },
      take: 500,
    });
    for (const e of expiredShifts) await this.expireShift(e.id);
  }
}
