// =====================================================================
//  IdleController — ingestion endpoint for the IdleTracker desktop agent
//  (separate repo: idle-tracker; a small cross-platform C++ agent that
//  watches keyboard/mouse idle time on floor machines).
//
//  POST /idle-events
//    headers: x-agent-key: <IDLE_AGENT_KEY env>       (fleet shared key)
//    body:    { employeeCode, event: "idle_start"|"idle_end", idleMs, ts? }
//
//  Policy (mirrors the break-overrun rule in break-enforcement.service.ts):
//    - FLOOR-LEVEL employees only (no privileged role): an idle_start at or
//      past the server threshold AUTO-CLOCKS-OUT the open shift — activity
//      sessions end, the entry becomes AUTO_CLOSED, paid time stops "now".
//    - Privileged staff are never auto-clocked-out by idle.
//    - Idle while ON BREAK is expected; break enforcement owns that case.
//    - Every clock-out writes a ComplianceViolation (IDLE_TIMEOUT) and an
//      AuditLog row, and pushes WebSocket events to the employee + approvers,
//      so the action is visible and reviewable — pay-affecting automation
//      must leave a trail.
//
//  The agent notifies the user on-screen before/at idle_start, so employees
//  are warned before the clock-out lands (see idle-tracker README on
//  disclosure requirements for workplace deployment).
// =====================================================================

import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  NotFoundException,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TimeEntryStatus, ViolationType } from '@prisma/client';
import { TimeEventsPublisher } from '../time-tracking/time-tracking.gateway';
import { EXEMPT_ROLES } from '../time-tracking/break-enforcement.service';

// Server-side floor for acting on an idle report. The agent has its own
// threshold; this guard means a misconfigured agent (e.g. a 10s threshold
// left over from testing) can never clock anyone out early. Keep the agent's
// idle_threshold_seconds equal to this value so reports act immediately.
const idleClockoutMs = () =>
  Number(process.env.IDLE_CLOCKOUT_SECONDS ?? 300) * 1000;

interface IdleEventBody {
  employeeCode: string;
  event: 'idle_start' | 'idle_end';
  idleMs: number;
  ts?: string; // agent-side UTC timestamp, audit-logged only — server time rules
}

@Controller('idle-events')
export class IdleController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: TimeEventsPublisher,
  ) {}

  @Post()
  async ingest(
    @Headers('x-agent-key') agentKey: string | undefined,
    @Body() body: IdleEventBody,
  ) {
    // Fleet-key auth. The endpoint is disabled until the key is configured,
    // so a fresh deployment can never be driven by an unauthenticated agent.
    const expected = process.env.IDLE_AGENT_KEY;
    if (!expected)
      throw new ServiceUnavailableException(
        'Idle ingestion is not enabled (IDLE_AGENT_KEY is unset).',
      );
    if (!agentKey || agentKey !== expected)
      throw new UnauthorizedException('Invalid agent key.');

    if (!body?.employeeCode || !body.event)
      throw new BadRequestException('employeeCode and event are required.');
    const idleMs = Number(body.idleMs);
    if (!Number.isFinite(idleMs) || idleMs < 0)
      throw new BadRequestException('idleMs must be a non-negative number.');

    const employee = await this.prisma.employee.findFirst({
      where: { employeeCode: body.employeeCode, active: true },
      select: { id: true, user: { select: { roles: true } } },
    });
    if (!employee) throw new NotFoundException('Unknown employee code.');

    // idle_end is informational — the shift (if any) was already closed at
    // idle_start, and an idle period that never crossed the threshold needs
    // no action. Acknowledge so the agent doesn't retry.
    if (body.event === 'idle_end') return { action: 'noted' };
    if (body.event !== 'idle_start')
      throw new BadRequestException(`Unknown event "${body.event}".`);

    const roles = employee.user?.roles ?? [];
    const isFloorEmployee = !roles.some((r) => EXEMPT_ROLES.includes(r));
    if (!isFloorEmployee) return { action: 'exempt_role' };

    if (idleMs < idleClockoutMs()) return { action: 'below_threshold' };

    const entry = await this.prisma.timeEntry.findFirst({
      where: { employeeId: employee.id, status: TimeEntryStatus.OPEN },
      include: { breaks: { where: { endedAt: null }, select: { id: true } } },
    });
    if (!entry) return { action: 'not_clocked_in' };

    // On an open break the machine is *supposed* to be idle; the break's own
    // deadline job already auto-clocks-out floor employees on overrun.
    if (entry.breaks.length > 0) return { action: 'on_break' };

    // ── AUTO CLOCK-OUT (same shape as the break-overrun branch) ─────────
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.activitySession.updateMany({
        where: { timeEntryId: entry.id, endedAt: null },
        data: { endedAt: now }, // stop paid-time accrual
      }),
      this.prisma.timeEntry.update({
        where: { id: entry.id },
        data: { status: TimeEntryStatus.AUTO_CLOSED, clockOutAt: now },
      }),
      this.prisma.complianceViolation.create({
        data: {
          employeeId: employee.id,
          type: ViolationType.IDLE_TIMEOUT,
          detail: `No keyboard/mouse input for ${Math.round(idleMs / 60000)} min (agent-reported); employee auto-clocked-out.`,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          action: 'IDLE_AUTO_LOGOUT',
          entity: 'TimeEntry',
          entityId: entry.id,
          payload: { idleMs, agentTs: body.ts ?? null, source: 'idle-tracker-agent' },
        },
      }),
    ]);

    // The pending 8h SHIFT_EXPIRY job no-ops on a non-OPEN entry — nothing to cancel.
    this.events.toEmployee(employee.id, {
      type: 'AUTO_CLOCKED_OUT',
      reason: 'IDLE_TIMEOUT',
      idleMs,
    });
    this.events.toApprovers(employee.id, {
      type: 'EMPLOYEE_AUTO_CLOCKED_OUT',
      employeeId: employee.id,
      reason: 'IDLE_TIMEOUT',
    });

    return { action: 'clocked_out', timeEntryId: entry.id };
  }
}
