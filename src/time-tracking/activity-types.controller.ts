import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  UseGuards,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { CreateActivityTypeDto } from './activity-types.dto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: string[] };
}

@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('activity-types')
export class ActivityTypesController {
  constructor(private readonly prisma: PrismaService) {}

  private async orgIdFor(employeeId: string): Promise<string> {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { orgId: true },
    });
    if (!emp) throw new NotFoundException('Employee not found');
    return emp.orgId;
  }

  /** All active activity types for the caller's org. The org catalog the
   *  console manages and assigns from. Available to every role. */
  @Get()
  async list(@Req() req: AuthedReq) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    return this.prisma.activityType.findMany({
      where: { orgId, active: true },
      orderBy: { name: 'asc' },
      select: { id: true, name: true },
    });
  }

  /** Activity types actually available to the caller = assigned to them
   *  directly, to their team, OR org-wide (all members). This is what the
   *  employee clock picks from. */
  @Get('mine')
  async mine(@Req() req: AuthedReq) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { teamId: true, orgId: true },
    });
    const targets: any[] = [{ employeeId: req.user.employeeId }];
    if (emp?.teamId) targets.push({ teamId: emp.teamId });
    if (emp) targets.push({ employeeId: null, teamId: null, activityType: { orgId: emp.orgId } }); // org-wide

    const assignments = await this.prisma.activityAssignment.findMany({
      where: { active: true, activityType: { active: true }, OR: targets },
      include: { activityType: { select: { id: true, name: true } } },
    });

    // Dedupe (an activity may be assigned both directly and via the team).
    const seen = new Map<string, { id: string; name: string }>();
    for (const a of assignments) {
      if (!seen.has(a.activityType.id)) seen.set(a.activityType.id, a.activityType);
    }
    return [...seen.values()].sort((x, y) => x.name.localeCompare(y.name));
  }

  /** Team Lead (or above) adds a new activity type to their org. */
  @Roles('WFM', 'ADMIN')
  @Post()
  async create(@Req() req: AuthedReq, @Body() body: CreateActivityTypeDto) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    const name = (body.name ?? '').trim();
    if (!name) throw new BadRequestException('Activity name is required.');

    // A previously-removed activity is soft-deleted (active=false), but the
    // unique [orgId, name] row still exists. Re-adding the same name should
    // simply reactivate it rather than collide.
    const existing = await this.prisma.activityType.findUnique({
      where: { orgId_name: { orgId, name } },
    });
    if (existing) {
      if (existing.active) throw new ConflictException(`"${name}" already exists.`);
      return this.prisma.activityType.update({
        where: { id: existing.id },
        data: { active: true },
        select: { id: true, name: true },
      });
    }

    try {
      return await this.prisma.activityType.create({
        data: { orgId, name },
        select: { id: true, name: true },
      });
    } catch (e) {
      // Race: a concurrent create slipped in between the lookup and here.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new ConflictException(`"${name}" already exists.`);
      }
      throw e;
    }
  }

  /** Team Lead (or above) soft-deletes an activity type (preserves history). */
  @Roles('WFM', 'ADMIN')
  @Delete(':id')
  async remove(@Req() req: AuthedReq, @Param('id') id: string) {
    const orgId = await this.orgIdFor(req.user.employeeId);
    const existing = await this.prisma.activityType.findUnique({ where: { id } });
    if (!existing || existing.orgId !== orgId || !existing.active) {
      throw new NotFoundException('Activity type not found.');
    }
    await this.prisma.activityType.update({
      where: { id },
      data: { active: false },
    });
    return { ok: true };
  }
}
