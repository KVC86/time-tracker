// =====================================================================
//  TimeTrackingGateway  +  TimeEventsPublisher
//
//  Replaces the prototype's localStorage polling (setInterval 2000) with
//  real WebSocket push. Scales across the 3-node app tier via the
//  Socket.IO Redis adapter: a publish on ANY node reaches the target
//  socket on WHATEVER node it's connected to.
//
//  Rooms:
//    employee:{id}   — that employee's own clock (break/shift/auto-logout)
//    approvers:{id}  — the Team Leads/Managers watching that employee
//                      (consumed approvals, violations, auto-logouts)
//
//  Setup once in main.ts:
//    const pub = createClient({ url: process.env.REDIS_URL });
//    const sub = pub.duplicate();
//    await Promise.all([pub.connect(), sub.connect()]);
//    app.useWebSocketAdapter(new RedisIoAdapter(app, pub, sub));
// =====================================================================

import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../prisma/prisma.service';

@WebSocketGateway({ cors: { origin: process.env.WEB_ORIGIN ?? '*' } })
export class TimeTrackingGateway implements OnGatewayConnection {
  @WebSocketServer() server: Server;
  private readonly log = new Logger(TimeTrackingGateway.name);

  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  /** Authenticate the socket from its JWT and join the right rooms. */
  async handleConnection(client: Socket) {
    try {
      const token =
        client.handshake.auth?.token ??
        (client.handshake.headers.authorization ?? '').replace('Bearer ', '');
      const payload: any = await this.jwt.verifyAsync(token);
      if (payload.typ !== 'access') throw new Error('wrong token type');

      const employeeId = payload.employeeId as string | undefined;
      const roles = (payload.roles as string[]) ?? [];
      client.data.employeeId = employeeId;
      client.data.roles = roles;

      if (employeeId) {
        client.join(`employee:${employeeId}`);
      }

      // Resolve supervised agents from the DB (not from the token — a
      // manager can supervise hundreds; that doesn't belong in a JWT).
      // Convention: TEAM_LEAD watches their team; MANAGER watches their dept.
      if (employeeId && (roles.includes('TEAM_LEAD') || roles.includes('MANAGER') || roles.includes('WFM'))) {
        const me = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          include: { team: true },
        });
        if (me?.teamId) {
          const where = roles.includes('MANAGER')
            ? { team: { departmentId: me.team!.departmentId } }
            : { teamId: me.teamId };
          const supervised = await this.prisma.employee.findMany({
            where,
            select: { id: true },
          });
          for (const e of supervised) client.join(`approvers:${e.id}`);
        }
      }

      // WFM/Admin get an org-wide activity channel for the named action log.
      if (employeeId && (roles.includes('WFM') || roles.includes('ADMIN'))) {
        const meOrg = await this.prisma.employee.findUnique({
          where: { id: employeeId },
          select: { orgId: true },
        });
        if (meOrg) client.join(`activity:${meOrg.orgId}`);
      }
    } catch {
      client.disconnect(true); // reject unauthenticated sockets
    }
  }

  /** Optional: a TL console can dynamically watch an employee. */
  @SubscribeMessage('watch:employee')
  watch(@MessageBody() employeeId: string, @ConnectedSocket() client: Socket) {
    // (authorize that this TL supervises employeeId before joining)
    client.join(`approvers:${employeeId}`);
  }

  // ── Consent-based screen sharing: relay WebRTC signaling between a manager
  //    (viewer) and an employee (sharer). The employee must approve, and the
  //    browser shows its own sharing indicator — there is no silent capture.
  @SubscribeMessage('screen:request')
  async screenRequest(
    @MessageBody() body: { targetEmployeeId: string },
    @ConnectedSocket() client: Socket,
  ) {
    const roles: string[] = client.data?.roles ?? [];
    if (!roles.some((r) => ['MANAGER', 'HR', 'ADMIN'].includes(r))) return;
    const me = await this.prisma.employee.findUnique({
      where: { id: client.data?.employeeId },
      select: { fullName: true },
    });
    this.server.to(`employee:${body.targetEmployeeId}`).emit('screen:request', {
      fromSocketId: client.id,
      fromName: me?.fullName ?? 'A manager',
    });
  }

  @SubscribeMessage('screen:offer')
  screenOffer(
    @MessageBody() body: { toSocketId: string; sdp: unknown; employeeId: string },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.to(body.toSocketId).emit('screen:offer', {
      fromSocketId: client.id,
      sdp: body.sdp,
      employeeId: body.employeeId,
    });
  }

  @SubscribeMessage('screen:answer')
  screenAnswer(
    @MessageBody() body: { toSocketId: string; sdp: unknown },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.to(body.toSocketId).emit('screen:answer', { fromSocketId: client.id, sdp: body.sdp });
  }

  @SubscribeMessage('screen:ice')
  screenIce(
    @MessageBody() body: { toSocketId: string; candidate: unknown },
    @ConnectedSocket() client: Socket,
  ) {
    this.server.to(body.toSocketId).emit('screen:ice', { fromSocketId: client.id, candidate: body.candidate });
  }

  @SubscribeMessage('screen:stop')
  screenStop(@MessageBody() body: { toSocketId: string }, @ConnectedSocket() client: Socket) {
    this.server.to(body.toSocketId).emit('screen:stop', { fromSocketId: client.id });
  }

  @SubscribeMessage('screen:decline')
  screenDecline(@MessageBody() body: { toSocketId: string }, @ConnectedSocket() client: Socket) {
    this.server.to(body.toSocketId).emit('screen:decline', { fromSocketId: client.id });
  }
}

// ─────────────────────────────────────────────────────────────────────
//  Thin publisher injected into services. Keeps services decoupled from
//  socket.io internals and works regardless of which node emits.
// ─────────────────────────────────────────────────────────────────────

@Injectable()
export class TimeEventsPublisher {
  constructor(private readonly gateway: TimeTrackingGateway) {}

  /** Push to the employee's own clock UI. */
  toEmployee(employeeId: string, event: Record<string, unknown>) {
    this.gateway.server.to(`employee:${employeeId}`).emit('time:event', event);
  }

  /** Push to the Team Leads/Managers watching this employee. */
  toApprovers(employeeId: string, event: Record<string, unknown>) {
    this.gateway.server.to(`approvers:${employeeId}`).emit('time:approver', event);
  }

  /** Push to the org-wide WFM activity log. */
  toActivity(orgId: string, event: Record<string, unknown>) {
    this.gateway.server.to(`activity:${orgId}`).emit('time:activity', event);
  }
}
