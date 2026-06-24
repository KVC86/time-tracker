import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Req,
  UseGuards,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Role } from '@prisma/client';

interface AuthedReq {
  user: { userId: string; employeeId: string; roles: Role[] };
}

// WFM/Admin build teams: create them, set a manager + team lead, add members.
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('WFM', 'ADMIN')
@Controller('admin/teams')
export class TeamsController {
  constructor(private readonly prisma: PrismaService) {}

  private async orgId(req: AuthedReq): Promise<string> {
    const me = await this.prisma.employee.findUnique({
      where: { id: req.user.employeeId },
      select: { orgId: true },
    });
    if (!me) throw new NotFoundException('Employee not found');
    return me.orgId;
  }

  @Get()
  async list(@Req() req: AuthedReq) {
    const orgId = await this.orgId(req);
    const teams = await this.prisma.team.findMany({
      where: { department: { orgId } },
      orderBy: { name: 'asc' },
      include: {
        lead: { select: { id: true, employeeCode: true, fullName: true } },
        manager: { select: { id: true, employeeCode: true, fullName: true } },
        employees: {
          select: { id: true, employeeCode: true, fullName: true, user: { select: { roles: true } } },
          orderBy: { employeeCode: 'asc' },
        },
      },
    });
    return teams.map((t) => ({
      id: t.id,
      name: t.name,
      photoUrl: t.photoUrl,
      lead: t.lead,
      manager: t.manager,
      members: t.employees.map((e) => ({
        id: e.id,
        employeeCode: e.employeeCode,
        fullName: e.fullName,
        roles: e.user?.roles ?? [],
      })),
    }));
  }

  @Post()
  async create(@Req() req: AuthedReq, @Body() body: { name: string }) {
    const orgId = await this.orgId(req);
    const name = (body.name ?? '').trim();
    if (!name) throw new BadRequestException('Team name is required.');
    let dept = await this.prisma.department.findFirst({ where: { orgId }, orderBy: { name: 'asc' } });
    if (!dept) dept = await this.prisma.department.create({ data: { orgId, name: 'Operations' } });
    const team = await this.prisma.team.create({ data: { departmentId: dept.id, name } });
    return { id: team.id, name: team.name };
  }

  @Patch(':id')
  async update(
    @Req() req: AuthedReq,
    @Param('id') id: string,
    @Body() body: { name?: string; leadId?: string | null; managerId?: string | null },
  ) {
    const orgId = await this.orgId(req);
    const team = await this.prisma.team.findUnique({ where: { id }, include: { department: true } });
    if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');

    const data: any = {};
    if (body.name !== undefined) {
      const name = (body.name ?? '').trim();
      if (!name) throw new BadRequestException('Team name cannot be empty.');
      data.name = name;
    }
    if (body.leadId !== undefined) {
      if (!body.leadId) data.leadId = null;
      else {
        const lead = await this.requireRole(body.leadId, orgId, 'TEAM_LEAD', 'The team lead must have the Team Lead role.');
        data.leadId = lead.id;
        // Keep the lead a member of this team so their supervision scope matches.
        await this.prisma.employee.update({ where: { id: lead.id }, data: { teamId: id } });
      }
    }
    if (body.managerId !== undefined) {
      if (!body.managerId) data.managerId = null;
      else {
        const mgr = await this.requireRole(body.managerId, orgId, 'MANAGER', 'The manager must have the Manager role.');
        data.managerId = mgr.id;
      }
    }
    await this.prisma.team.update({ where: { id }, data });
    return { ok: true };
  }

  @Post(':id/members')
  async addMember(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: { employeeId: string }) {
    const orgId = await this.orgId(req);
    const team = await this.prisma.team.findUnique({ where: { id }, include: { department: true } });
    if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');
    const emp = await this.prisma.employee.findUnique({ where: { id: body.employeeId }, select: { orgId: true } });
    if (!emp || emp.orgId !== orgId) throw new NotFoundException('Employee not found.');
    await this.prisma.employee.update({ where: { id: body.employeeId }, data: { teamId: id } });
    return { ok: true };
  }

  /** Remove a member from a team (clears their team). Also clears the
   *  lead/manager slot if the removed person held it. */
  @Post(':id/remove-member')
  async removeMember(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: { employeeId: string }) {
    const orgId = await this.orgId(req);
    const team = await this.prisma.team.findUnique({ where: { id }, include: { department: true } });
    if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');
    await this.prisma.employee.updateMany({
      where: { id: body.employeeId, teamId: id },
      data: { teamId: null },
    });
    const clear: any = {};
    if (team.leadId === body.employeeId) clear.leadId = null;
    if (team.managerId === body.employeeId) clear.managerId = null;
    if (Object.keys(clear).length) await this.prisma.team.update({ where: { id }, data: clear });
    return { ok: true };
  }

  /** Upload/replace a team's group photo (base64 data URL). */
  @Post(':id/photo')
  async setPhoto(@Req() req: AuthedReq, @Param('id') id: string, @Body() body: { photo: string }) {
    const orgId = await this.orgId(req);
    const team = await this.prisma.team.findUnique({ where: { id }, include: { department: true } });
    if (!team || team.department.orgId !== orgId) throw new NotFoundException('Team not found.');
    const photo = body.photo ?? '';
    if (!photo.startsWith('data:image/')) throw new BadRequestException('Photo must be an image data URL.');
    if (photo.length > 2_000_000) throw new BadRequestException('Image is too large (max ~1.5 MB).');
    await this.prisma.team.update({ where: { id }, data: { photoUrl: photo } });
    return { ok: true };
  }

  private async requireRole(employeeId: string, orgId: string, role: Role, msg: string) {
    const emp = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      include: { user: { select: { roles: true } } },
    });
    if (!emp || emp.orgId !== orgId) throw new NotFoundException('Employee not found.');
    if (!(emp.user?.roles ?? []).includes(role)) throw new BadRequestException(msg);
    return emp;
  }
}
