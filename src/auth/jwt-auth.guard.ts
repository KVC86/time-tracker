// =====================================================================
//  JwtAuthGuard — REAL guard (replaces the earlier dev header stub).
//  Verifies the Bearer access token and populates req.user with the
//  shape the rest of the app expects: { userId, employeeId, roles }.
// =====================================================================

import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwt: JwtService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const header: string = req.headers['authorization'] ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw new UnauthorizedException('Missing bearer token.');

    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired token.');
    }
    if (payload.typ !== 'access')
      throw new UnauthorizedException('Wrong token type.');

    req.user = {
      userId: payload.sub,
      employeeId: payload.employeeId,
      roles: payload.roles ?? [],
    };
    return true;
  }
}
