import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { SetRateDto, GeneratePayrollDto, AddPayslipLineDto, UpdatePayslipLineDto } from './payroll.dto';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import {
  Role,
  PayComponentKind,
  PayComponentMethod,
  PayComponentScope,
  PayslipStatus,
  PayslipLineCategory,
} from '@prisma/client';
import { classifyOvertime, nightOverlapHours } from '../common/overtime';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

const HOUR = 3_600_000;

interface EarnRow {
  employeeId: string;
  employeeCode: string;
  fullName: string;
  teamId: string | null;
  rate: number;
  regularHours: number;
  overtimeHours: number;   // OT + NDOT (non-rest overtime)
  otHours: number;
  ndotHours: number;
  rdOvertimeHours: number; // RDOT + RDNDOT (rest-day overtime)
  rdotHours: number;
  rdndotHours: number;
  nightHours: number;      // all worked night hours (regular + OT)
  regularPay: number;
  otPay: number;
  ndotPay: number;
  rdotPay: number;
  rdndotPay: number;
  nightPay: number;        // differential on REGULAR (non-OT) night hours only
  gross: number;
}

const round = (n: number) => Math.round(n * 100) / 100;

// Payroll specialist console: pay rates, statutory deductions & allowances,
// and payslip generation/edit/release. Worked time comes from activity
// sessions (breaks are excluded by design, since starting a break closes the
// open activity session).
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PAYROLL', 'ADMIN')
@Controller('payroll')
export class PayrollController {
  constructor(private readonly prisma: PrismaService) {}

  private async orgId(req: AuthedReq): Promise<string> {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true },
    });
    if (!me) throw new NotFoundException('Employee not found');
    return me.orgId;
  }

  // ───────────────────────────── PAY RATES ─────────────────────────────

  /** Everyone in the org with their current hourly rate. */
  @Get('rates')
  async rates(@Req() req: AuthedReq) {
    const orgId = await this.orgId(req);
    return this.prisma.employee.findMany({
      where: { orgId, active: true },
      select: { id: true, employeeCode: true, fullName: true, hourlyRate: true },
      orderBy: { employeeCode: 'asc' },
    });
  }

  /** Set an employee's hourly rate. */
  @Post('rates')
  async setRate(@Req() req: AuthedReq, @Body() body: SetRateDto) {
    const orgId = await this.orgId(req);
    const rate = Number(body.hourlyRate);
    if (!body.employeeId) throw new BadRequestException('employeeId is required.');
    if (!Number.isFinite(rate) || rate < 0) throw new BadRequestException('hourlyRate must be a non-negative number.');
    const emp = await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { orgId: true } });
    if (!emp || emp.orgId !== orgId) throw new NotFoundException('Employee not found.');
    await this.prisma.employee.update({ where: { id: body.employeeId }, data: { hourlyRate: rate } });
    return { ok: true };
  }

  /** Teams + employees in the org, for the component "applies to" picker. */
  @Get('targets')
  async targets(@Req() req: AuthedReq) {
    const orgId = await this.orgId(req);
    const [employees, teams] = await Promise.all([
      this.prisma.employee.findMany({
        where: { orgId, active: true },
        select: { id: true, employeeCode: true, fullName: true },
        orderBy: { employeeCode: 'asc' },
      }),
      this.prisma.team.findMany({
        where: { department: { orgId } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);
    return { employees, teams };
  }

  // ─────────────────────────── EARNINGS ENGINE ─────────────────────────
  // Shared by /run (live preview) and payslip generation, so gross pay is
  // computed identically in both places.

  private async computeEarnings(
    orgId: string,
    periodStart: Date,
    periodEndExclusive: Date,
    employeeId?: string,
  ): Promise<EarnRow[]> {
    const policy = await this.prisma.shiftPolicy.findFirst({ where: { orgId }, orderBy: { createdAt: 'asc' } });
    const otMult = policy?.otMultiplier ?? 1.5;
    const rdOtMult = policy?.rdOtMultiplier ?? 1.69;
    const nightPct = policy?.nightDiffPercent ?? 10;

    const employees = await this.prisma.employee.findMany({
      where: { orgId, active: true, ...(employeeId ? { id: employeeId } : {}) },
      select: { id: true, employeeCode: true, fullName: true, teamId: true, hourlyRate: true },
      orderBy: { employeeCode: 'asc' },
    });
    const sessions = await this.prisma.activitySession.findMany({
      where: {
        timeEntry: { employee: { orgId }, ...(employeeId ? { employeeId } : {}) },
        startedAt: { lt: periodEndExclusive },
        OR: [{ endedAt: null }, { endedAt: { gt: periodStart } }],
      },
      select: { startedAt: true, endedAt: true, timeEntry: { select: { employeeId: true, shiftEndsAt: true, clockOutAt: true } } },
    });

    // Authorized overtime windows (WFM-granted) overlapping the period. OT is
    // authorization-based: only worked time inside one of these windows is paid
    // as overtime; all other worked time is regular.
    const otRows = await this.prisma.schedule.findMany({
      where: {
        employee: { orgId, ...(employeeId ? { id: employeeId } : {}) },
        otStart: { not: null, lt: periodEndExclusive },
        otEnd: { gt: periodStart },
      },
      select: { employeeId: true, otStart: true, otEnd: true, isRestDay: true },
    });
    // Two window lists per employee: OT on a rest day (paid at the RD-OT
    // premium) vs OT on a working day (regular OT multiplier). A day is either
    // a rest day or a working day, so the two lists never overlap.
    const otByEmp = new Map<string, { start: number; end: number }[]>();
    const rdOtByEmp = new Map<string, { start: number; end: number }[]>();
    for (const w of otRows) {
      if (!w.otStart || !w.otEnd) continue;
      const bucket = w.isRestDay ? rdOtByEmp : otByEmp;
      if (!bucket.has(w.employeeId)) bucket.set(w.employeeId, []);
      bucket.get(w.employeeId)!.push({ start: w.otStart.getTime(), end: w.otEnd.getTime() });
    }

    const now = new Date();
    const byEmp = new Map<string, { startedAt: Date; endedAt: Date }[]>();
    for (const s of sessions) {
      const te = s.timeEntry;
      const eid = te.employeeId;
      // A still-open session can't legitimately run past the shift's hard end
      // (the clock-out, or the 8h window). Cap it so a never-closed session
      // doesn't accrue hours up to "now" on a historical payroll run.
      const shiftBound = (te.clockOutAt ?? te.shiftEndsAt).getTime();
      const sessionEnd = Math.min((s.endedAt ?? now).getTime(), shiftBound);
      const segStart = new Date(Math.max(s.startedAt.getTime(), periodStart.getTime()));
      const segEnd = new Date(Math.min(sessionEnd, periodEndExclusive.getTime()));
      if (segEnd <= segStart) continue;
      if (!byEmp.has(eid)) byEmp.set(eid, []);
      byEmp.get(eid)!.push({ startedAt: segStart, endedAt: segEnd });
    }

    // Intersect a segment with a list of OT windows → the overlapping
    // sub-intervals, so each can be classified into day/night hours.
    const intersect = (seg: { startedAt: Date; endedAt: Date }, wins: { start: number; end: number }[]) => {
      const out: { start: number; end: number }[] = [];
      for (const w of wins) {
        const start = Math.max(seg.startedAt.getTime(), w.start);
        const end = Math.min(seg.endedAt.getTime(), w.end);
        if (end > start) out.push({ start, end });
      }
      return out;
    };

    return employees.map((e) => {
      const segs = byEmp.get(e.id) ?? [];
      const wins = otByEmp.get(e.id) ?? [];
      const rdWins = rdOtByEmp.get(e.id) ?? [];
      let regular = 0, ot = 0, ndot = 0, rdot = 0, rdndot = 0, nightAll = 0;
      for (const seg of segs) {
        const segMs = seg.endedAt.getTime() - seg.startedAt.getTime();
        let otMs = 0;
        // Rest-day OT windows take precedence; the two sets are disjoint anyway.
        for (const iv of intersect(seg, rdWins)) {
          const c = classifyOvertime(new Date(iv.start), new Date(iv.end), true);
          rdot += c.rdot; rdndot += c.rdndot; otMs += iv.end - iv.start;
        }
        for (const iv of intersect(seg, wins)) {
          const c = classifyOvertime(new Date(iv.start), new Date(iv.end), false);
          ot += c.ot; ndot += c.ndot; otMs += iv.end - iv.start;
        }
        otMs = Math.min(otMs, segMs); // guard against overlapping windows
        regular += (segMs - otMs) / HOUR;
        nightAll += nightOverlapHours(seg.startedAt, seg.endedAt);
      }
      // Night differential is a +% add-on. For OT night hours it's folded into
      // the NDOT/RDNDOT rates, so the standalone night line covers only the
      // REGULAR (non-OT) night hours.
      const regularNight = Math.max(0, nightAll - ndot - rdndot);
      const rate = e.hourlyRate ?? 0;
      const nd = nightPct / 100;
      const regularPay = regular * rate;
      const otPay = ot * rate * otMult;
      const ndotPay = ndot * rate * (otMult + nd);
      const rdotPay = rdot * rate * rdOtMult;
      const rdndotPay = rdndot * rate * (rdOtMult + nd);
      const nightPay = regularNight * rate * nd;
      return {
        employeeId: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        teamId: e.teamId,
        rate,
        regularHours: round(regular),
        overtimeHours: round(ot + ndot),
        otHours: round(ot),
        ndotHours: round(ndot),
        rdOvertimeHours: round(rdot + rdndot),
        rdotHours: round(rdot),
        rdndotHours: round(rdndot),
        nightHours: round(nightAll),
        regularPay: round(regularPay),
        otPay: round(otPay),
        ndotPay: round(ndotPay),
        rdotPay: round(rdotPay),
        rdndotPay: round(rdndotPay),
        nightPay: round(nightPay),
        gross: round(regularPay + otPay + ndotPay + rdotPay + rdndotPay + nightPay),
      };
    });
  }

  /** Live preview of pay for a date range (no persistence). */
  @Get('run')
  async run(@Req() req: AuthedReq, @Query('start') start?: string, @Query('end') end?: string) {
    const { earnStart, earnEndExclusive } = this.parsePeriod(start, end);
    const orgId = await this.orgId(req);
    const rows = await this.computeEarnings(orgId, earnStart, earnEndExclusive);
    return rows.map((r) => ({
      employeeId: r.employeeId,
      employeeCode: r.employeeCode,
      fullName: r.fullName,
      rate: r.rate,
      regularHours: r.regularHours,
      overtimeHours: r.overtimeHours,
      ndotHours: r.ndotHours,
      rdOvertimeHours: r.rdOvertimeHours,
      rdndotHours: r.rdndotHours,
      nightHours: r.nightHours,
      gross: r.gross,
    }));
  }

  private parsePeriod(start?: string, end?: string) {
    if (!start || !end) throw new BadRequestException('start and end dates are required.');
    // Earnings window: local-time day boundaries (matches the original /run,
    // since it filters timestamp columns).
    const earnStart = new Date(`${start}T00:00:00`);
    const earnEnd = new Date(`${end}T00:00:00`);
    if (isNaN(earnStart.getTime()) || isNaN(earnEnd.getTime())) throw new BadRequestException('Invalid date.');
    const earnEndExclusive = new Date(earnEnd);
    earnEndExclusive.setDate(earnEndExclusive.getDate() + 1); // make the end date inclusive
    if (earnEndExclusive <= earnStart) throw new BadRequestException('end must be on or after start.');
    // Stored period labels: UTC-midnight of the calendar date, so the @db.Date
    // round-trips to the date the user picked regardless of server timezone.
    const labelStart = new Date(`${start}T00:00:00Z`);
    const labelEnd = new Date(`${end}T00:00:00Z`);
    return { earnStart, earnEndExclusive, labelStart, labelEnd };
  }

  // ──────────────────────── PAY COMPONENTS (CRUD) ──────────────────────
  // SSS, PhilHealth, allowances, etc. — reusable definitions applied at
  // payslip-generation time.

  @Get('components')
  async listComponents(@Req() req: AuthedReq) {
    const orgId = await this.orgId(req);
    const comps = await this.prisma.payComponent.findMany({
      where: { orgId },
      include: {
        team: { select: { name: true } },
        employee: { select: { employeeCode: true, fullName: true } },
      },
      orderBy: [{ kind: 'asc' }, { name: 'asc' }],
    });
    return comps.map((c) => ({
      id: c.id,
      kind: c.kind,
      name: c.name,
      method: c.method,
      amount: c.amount,
      percent: c.percent,
      brackets: c.brackets,
      scope: c.scope,
      teamId: c.teamId,
      employeeId: c.employeeId,
      active: c.active,
      targetLabel:
        c.scope === 'TEAM'
          ? c.team?.name ?? 'Team'
          : c.scope === 'EMPLOYEE'
          ? `${c.employee?.employeeCode ?? ''} ${c.employee?.fullName ?? ''}`.trim()
          : 'Everyone',
    }));
  }

  private async validateComponent(orgId: string, body: any) {
    const kind = body.kind as PayComponentKind;
    const method = body.method as PayComponentMethod;
    const scope = (body.scope ?? 'ORG') as PayComponentScope;
    if (!['ALLOWANCE', 'DEDUCTION'].includes(kind)) throw new BadRequestException('kind must be ALLOWANCE or DEDUCTION.');
    if (!['FIXED', 'PERCENT_OF_GROSS', 'BRACKET'].includes(method)) throw new BadRequestException('Invalid method.');
    if (!['ORG', 'TEAM', 'EMPLOYEE'].includes(scope)) throw new BadRequestException('Invalid scope.');
    if (!body.name || !String(body.name).trim()) throw new BadRequestException('name is required.');

    if (method === 'FIXED' && !(Number(body.amount) >= 0)) throw new BadRequestException('A fixed component needs a non-negative amount.');
    if (method === 'PERCENT_OF_GROSS' && !(Number(body.percent) >= 0)) throw new BadRequestException('A percent component needs a non-negative percent.');
    if (method === 'BRACKET' && (!Array.isArray(body.brackets) || !body.brackets.length))
      throw new BadRequestException('A bracket component needs at least one bracket.');

    let teamId: string | null = null;
    let employeeId: string | null = null;
    if (scope === 'TEAM') {
      if (!body.teamId) throw new BadRequestException('teamId is required for a team-scoped component.');
      const team = await this.prisma.team.findUnique({ where: { id: body.teamId }, include: { department: true } });
      if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');
      teamId = team.id;
    } else if (scope === 'EMPLOYEE') {
      if (!body.employeeId) throw new BadRequestException('employeeId is required for an employee-scoped component.');
      const emp = await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { orgId: true } });
      if (!emp || emp.orgId !== orgId) throw new NotFoundException('Employee not found.');
      employeeId = body.employeeId;
    }
    return {
      kind,
      method,
      scope,
      teamId,
      employeeId,
      name: String(body.name).trim(),
      amount: method === 'FIXED' ? Number(body.amount) : null,
      percent: method === 'PERCENT_OF_GROSS' ? Number(body.percent) : null,
      brackets: method === 'BRACKET' ? body.brackets : null,
      active: body.active === undefined ? true : !!body.active,
    };
  }

  @Post('components')
  async createComponent(@Req() req: AuthedReq, @Body() body: any) {
    const orgId = await this.orgId(req);
    const data = await this.validateComponent(orgId, body);
    const comp = await this.prisma.payComponent.create({ data: { orgId, ...data } });
    await this.audit(req, 'PAYCOMPONENT_CREATED', 'PayComponent', comp.id, { name: comp.name, kind: comp.kind });
    return { ok: true, id: comp.id };
  }

  @Patch('components/:id')
  async updateComponent(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: any) {
    const orgId = await this.orgId(req);
    const existing = await this.prisma.payComponent.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) throw new NotFoundException('Component not found.');
    const data = await this.validateComponent(orgId, { ...existing, ...body });
    await this.prisma.payComponent.update({ where: { id }, data });
    await this.audit(req, 'PAYCOMPONENT_UPDATED', 'PayComponent', id, { name: data.name });
    return { ok: true };
  }

  /** Remove a component. If any payslip line already references it, we
   *  deactivate instead of deleting so historical payslips stay intact. */
  @Delete('components/:id')
  async deleteComponent(@Req() req: AuthedReq, @Param('id') id: string) {
    const orgId = await this.orgId(req);
    const existing = await this.prisma.payComponent.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId) throw new NotFoundException('Component not found.');
    const inUse = await this.prisma.payslipLine.count({ where: { componentId: id } });
    if (inUse) {
      await this.prisma.payComponent.update({ where: { id }, data: { active: false } });
      await this.audit(req, 'PAYCOMPONENT_DEACTIVATED', 'PayComponent', id);
      return { ok: true, deactivated: true };
    }
    await this.prisma.payComponent.delete({ where: { id } });
    await this.audit(req, 'PAYCOMPONENT_DELETED', 'PayComponent', id);
    return { ok: true, deleted: true };
  }

  // ──────────────────────────── PAYSLIPS ───────────────────────────────

  private componentAmount(c: { method: PayComponentMethod; amount: number | null; percent: number | null; brackets: any }, gross: number): number {
    if (c.method === 'FIXED') return round(c.amount ?? 0);
    if (c.method === 'PERCENT_OF_GROSS') return round(gross * ((c.percent ?? 0) / 100));
    // BRACKET: bands sorted by ceiling ascending (the null "top" band last),
    // then the first band whose ceiling covers the gross applies. Sorting here
    // makes the result correct even if the bands were entered out of order.
    const rows: any[] = (Array.isArray(c.brackets) ? c.brackets : []).slice().sort((a, b) => {
      if (a.upTo == null) return 1;
      if (b.upTo == null) return -1;
      return Number(a.upTo) - Number(b.upTo);
    });
    for (const b of rows) {
      if (b.upTo == null || gross <= Number(b.upTo)) {
        if (b.amount != null) return round(Number(b.amount));
        if (b.percent != null) return round(gross * (Number(b.percent) / 100));
        return 0;
      }
    }
    return 0;
  }

  /** Generate (or regenerate) DRAFT payslips for a period. RELEASED payslips
   *  are never overwritten. Applies every active, in-scope pay component. */
  @Post('payslips/generate')
  async generate(@Req() req: AuthedReq, @Body() body: GeneratePayrollDto) {
    const { earnStart, earnEndExclusive, labelStart, labelEnd } = this.parsePeriod(body.start, body.end);
    const orgId = await this.orgId(req);

    const earnings = await this.computeEarnings(orgId, earnStart, earnEndExclusive, body.employeeId);
    const components = await this.prisma.payComponent.findMany({ where: { orgId, active: true } });

    // Pre-fetch existing payslips for this period in one query (avoids an
    // N+1 findUnique per employee).
    const existingSlips = await this.prisma.payslip.findMany({
      where: {
        periodStart: labelStart,
        periodEnd: labelEnd,
        employeeId: { in: earnings.map((e) => e.employeeId) },
      },
    });
    const existingByEmp = new Map(existingSlips.map((s) => [s.employeeId, s] as const));

    const generated: any[] = [];
    for (const e of earnings) {
      const existing = existingByEmp.get(e.employeeId);
      if (existing?.status === PayslipStatus.RELEASED) {
        generated.push({ employeeCode: e.employeeCode, fullName: e.fullName, skipped: 'released' });
        continue;
      }

      // EARNING lines from worked hours.
      const lines: { category: PayslipLineCategory; label: string; amount: number; origin: string; componentId?: string }[] = [
        { category: 'EARNING', label: 'Regular pay', amount: e.regularPay, origin: 'AUTO' },
      ];
      if (e.otPay > 0) lines.push({ category: 'EARNING', label: `Overtime pay (OT, ${e.otHours}h)`, amount: e.otPay, origin: 'AUTO' });
      if (e.ndotPay > 0) lines.push({ category: 'EARNING', label: `Night-diff OT pay (NDOT, ${e.ndotHours}h)`, amount: e.ndotPay, origin: 'AUTO' });
      if (e.rdotPay > 0) lines.push({ category: 'EARNING', label: `Rest day OT pay (RDOT, ${e.rdotHours}h)`, amount: e.rdotPay, origin: 'AUTO' });
      if (e.rdndotPay > 0) lines.push({ category: 'EARNING', label: `Rest day night-diff OT pay (RDNDOT, ${e.rdndotHours}h)`, amount: e.rdndotPay, origin: 'AUTO' });
      if (e.nightPay > 0) lines.push({ category: 'EARNING', label: 'Night differential', amount: e.nightPay, origin: 'AUTO' });

      // ALLOWANCE / DEDUCTION lines from applicable components.
      let totalAllowances = 0;
      let totalDeductions = 0;
      for (const c of components) {
        const applies =
          c.scope === 'ORG' ||
          (c.scope === 'TEAM' && c.teamId === e.teamId) ||
          (c.scope === 'EMPLOYEE' && c.employeeId === e.employeeId);
        if (!applies) continue;
        const amt = this.componentAmount(c, e.gross);
        if (amt <= 0) continue;
        const category: PayslipLineCategory = c.kind === 'ALLOWANCE' ? 'ALLOWANCE' : 'DEDUCTION';
        lines.push({ category, label: c.name, amount: amt, origin: 'AUTO', componentId: c.id });
        if (category === 'ALLOWANCE') totalAllowances += amt;
        else totalDeductions += amt;
      }

      const netPay = round(e.gross + totalAllowances - totalDeductions);

      await this.prisma.$transaction(async (tx) => {
        if (existing) await tx.payslip.delete({ where: { id: existing.id } }); // cascades lines
        await tx.payslip.create({
          data: {
            employeeId: e.employeeId,
            periodStart: labelStart,
            periodEnd: labelEnd,
            regularHours: e.regularHours,
            overtimeHours: e.overtimeHours,
            nightHours: e.nightHours,
            grossPay: e.gross,
            totalAllowances: round(totalAllowances),
            totalDeductions: round(totalDeductions),
            netPay,
            status: PayslipStatus.DRAFT,
            generatedById: req.user.employeeId,
            lines: { create: lines },
          },
        });
      });
      generated.push({ employeeCode: e.employeeCode, fullName: e.fullName, gross: e.gross, netPay, status: 'DRAFT' });
    }

    await this.audit(req, 'PAYSLIPS_GENERATED', 'Payslip', `${body.start}_${body.end}`, {
      count: generated.length,
      employeeId: body.employeeId,
    });
    return { ok: true, period: { start: body.start, end: body.end }, generated };
  }

  /** List payslips for a period (all statuses) so Payroll can edit/release. */
  @Get('payslips')
  async listPayslips(@Req() req: AuthedReq, @Query('start') start?: string, @Query('end') end?: string) {
    const { labelStart, labelEnd } = this.parsePeriod(start, end);
    const orgId = await this.orgId(req);
    const rows = await this.prisma.payslip.findMany({
      where: { periodStart: labelStart, periodEnd: labelEnd, employee: { orgId } },
      include: { employee: { select: { employeeCode: true, fullName: true } } },
      orderBy: { employee: { employeeCode: 'asc' } },
    });
    return rows.map((p) => ({
      id: p.id,
      employeeCode: p.employee.employeeCode,
      fullName: p.employee.fullName,
      grossPay: p.grossPay,
      totalAllowances: p.totalAllowances,
      totalDeductions: p.totalDeductions,
      netPay: p.netPay,
      status: p.status,
      releasedAt: p.releasedAt,
    }));
  }

  /** Full payslip with its line items, for the editor. */
  @Get('payslips/:id')
  async getPayslip(@Req() req: AuthedReq, @Param('id') id: string) {
    const orgId = await this.orgId(req);
    const p = await this.loadOwnedPayslip(orgId, id);
    return {
      ...this.payslipSummary(p),
      employeeCode: p.employee.employeeCode,
      fullName: p.employee.fullName,
      lines: p.lines.map((l) => ({ id: l.id, category: l.category, label: l.label, amount: l.amount, origin: l.origin })),
    };
  }

  @Post('payslips/:id/lines')
  async addLine(
    @Req() req: AuthedReq,
    @Param('id') id: string,
    @Body() body: AddPayslipLineDto,
  ) {
    const orgId = await this.orgId(req);
    const p = await this.loadOwnedPayslip(orgId, id);
    this.assertDraft(p);
    if (!['EARNING', 'ALLOWANCE', 'DEDUCTION'].includes(body.category)) throw new BadRequestException('Invalid category.');
    if (!body.label || !body.label.trim()) throw new BadRequestException('label is required.');
    const amount = Number(body.amount);
    if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('amount must be a non-negative number.');
    await this.prisma.payslipLine.create({
      data: { payslipId: id, category: body.category, label: body.label.trim(), amount: round(amount), origin: 'MANUAL' },
    });
    await this.recalc(id);
    return { ok: true };
  }

  @Patch('payslips/:id/lines/:lineId')
  async editLine(
    @Req() req: AuthedReq,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Body() body: UpdatePayslipLineDto,
  ) {
    const orgId = await this.orgId(req);
    const p = await this.loadOwnedPayslip(orgId, id);
    this.assertDraft(p);
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException('Line not found.');
    const data: any = { origin: 'MANUAL' };
    if (body.label !== undefined) {
      if (!body.label.trim()) throw new BadRequestException('label cannot be empty.');
      data.label = body.label.trim();
    }
    if (body.amount !== undefined) {
      const amount = Number(body.amount);
      if (!Number.isFinite(amount) || amount < 0) throw new BadRequestException('amount must be a non-negative number.');
      data.amount = round(amount);
    }
    await this.prisma.payslipLine.update({ where: { id: lineId }, data });
    await this.recalc(id);
    return { ok: true };
  }

  @Delete('payslips/:id/lines/:lineId')
  async deleteLine(@Req() req: AuthedReq, @Param('id') id: string, @Param('lineId') lineId: string) {
    const orgId = await this.orgId(req);
    const p = await this.loadOwnedPayslip(orgId, id);
    this.assertDraft(p);
    const line = p.lines.find((l) => l.id === lineId);
    if (!line) throw new NotFoundException('Line not found.');
    await this.prisma.payslipLine.delete({ where: { id: lineId } });
    await this.recalc(id);
    return { ok: true };
  }

  @Post('payslips/:id/release')
  async release(@Req() req: AuthedReq, @Param('id') id: string) {
    const orgId = await this.orgId(req);
    const p = await this.loadOwnedPayslip(orgId, id);
    if (p.status === PayslipStatus.RELEASED) throw new ConflictException('Payslip is already released.');
    await this.prisma.payslip.update({ where: { id }, data: { status: PayslipStatus.RELEASED, releasedAt: new Date() } });
    await this.audit(req, 'PAYSLIP_RELEASED', 'Payslip', id, { employeeId: p.employeeId });
    return { ok: true };
  }

  // ───────────────────────────── internals ─────────────────────────────

  private async loadOwnedPayslip(orgId: string, id: string) {
    const p = await this.prisma.payslip.findUnique({
      where: { id },
      include: { lines: true, employee: { select: { orgId: true, employeeCode: true, fullName: true } } },
    });
    if (!p || p.employee.orgId !== orgId) throw new NotFoundException('Payslip not found.');
    return p;
  }

  private assertDraft(p: { status: PayslipStatus }) {
    if (p.status !== PayslipStatus.DRAFT) throw new ConflictException('A released payslip cannot be edited.');
  }

  private payslipSummary(p: any) {
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
      status: p.status,
      releasedAt: p.releasedAt,
    };
  }

  /** Re-sum a payslip's lines into its totals after a manual edit. */
  private async recalc(payslipId: string) {
    const lines = await this.prisma.payslipLine.findMany({ where: { payslipId } });
    let gross = 0;
    let allowances = 0;
    let deductions = 0;
    for (const l of lines) {
      if (l.category === 'EARNING') gross += l.amount;
      else if (l.category === 'ALLOWANCE') allowances += l.amount;
      else deductions += l.amount;
    }
    await this.prisma.payslip.update({
      where: { id: payslipId },
      data: {
        grossPay: round(gross),
        totalAllowances: round(allowances),
        totalDeductions: round(deductions),
        netPay: round(gross + allowances - deductions),
      },
    });
  }

  private async audit(req: AuthedReq, action: string, entity: string, entityId: string, payload?: any) {
    await this.prisma.auditLog.create({
      data: { actorUserId: req.user.userId, action, entity, entityId, payload },
    });
  }

}
