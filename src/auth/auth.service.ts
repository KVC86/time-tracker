// =====================================================================
//  AuthService
//  - Sign in with EMAIL or EMPLOYEE CODE + password (argon2id).
//  - Role-based MFA: privileged roles → TOTP; floor agents → email OTP.
//  - Two-step login: password → short-lived mfaToken → factor → tokens.
//  - Access token (15m JWT) + rotating opaque refresh token (hashed).
// =====================================================================

import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { hash, verify } from '@node-rs/argon2';
import { authenticator } from 'otplib';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { EmailOtpService } from './email-otp.service';
import { Role } from '@prisma/client';

const PRIVILEGED: Role[] = ['TEAM_LEAD', 'WFM', 'MANAGER', 'HR', 'PAYROLL', 'ADMIN'];
// NOTE: 8h access token is a DEV convenience so hand-testing isn't interrupted.
// For production, drop this back to ~15m and rely on the refresh-token rotation.
const ACCESS_TTL = '8h';
const MFA_TTL = '5m';
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const ISSUER = 'WFM';

type MfaMethod = 'TOTP' | 'EMAIL';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly emailOtp: EmailOtpService,
  ) {}

  private methodFor(_roles: Role[]): MfaMethod {
    // Enterprise: authenticator-app (TOTP) MFA for every role, floor agents included.
    return 'TOTP';
  }

  /** Resolve a user by email (contains '@') or by employee code. */
  private async findByIdentifier(identifier: string) {
    if (identifier.includes('@')) {
      return this.prisma.user.findUnique({
        where: { email: identifier.toLowerCase() },
        include: { employee: true },
      });
    }
    // NOTE: employeeCode is unique per org. Single-tenant dev resolves the
    // first match; multi-tenant should scope by org (e.g. login subdomain).
    const employee = await this.prisma.employee.findFirst({
      where: { employeeCode: identifier },
    });
    if (!employee) return null;
    return this.prisma.user.findUnique({
      where: { employeeId: employee.id },
      include: { employee: true },
    });
  }

  // ─────────────────────────── STEP 1: login ─────────────────────────
  async login(identifier: string, password: string) {
    const user = await this.findByIdentifier(identifier);
    // Verify even on miss to blunt timing/enumeration; generic error either way.
    const ok = user
      ? await verify(user.passwordHash, password).catch(() => false)
      : await verify(
          '$argon2id$v=19$m=19456,t=2,p=1$ZHVtbXlzYWx0$0000000000000000000000000000000000000000000',
          password,
        ).catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Invalid credentials.');

    const method = this.methodFor(user.roles);
    const mfaToken = await this.jwt.signAsync(
      { sub: user.id, typ: 'mfa', method },
      { expiresIn: MFA_TTL },
    );

    if (method === 'TOTP') {
      if (!user.mfaSecret || !user.mfaEnrolledAt) {
        // First-time staff login: provision a secret to enroll an app.
        const secret = user.mfaSecret ?? authenticator.generateSecret();
        if (!user.mfaSecret) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { mfaSecret: secret },
          });
        }
        const otpauthUrl = authenticator.keyuri(user.email, ISSUER, secret);
        return { status: 'MFA_TOTP_ENROLL', mfaToken, otpauthUrl };
      }
      return { status: 'MFA_TOTP_REQUIRED', mfaToken };
    }

    // Floor agent: email a one-time code.
    await this.emailOtp.issue(user.id, user.email);
    return { status: 'MFA_EMAIL_OTP_SENT', mfaToken };
  }

  // ─────────────────────── STEP 2: verify factor ─────────────────────
  async verifyMfa(mfaToken: string, code: string) {
    let payload: any;
    try {
      payload = await this.jwt.verifyAsync(mfaToken);
    } catch {
      throw new UnauthorizedException('MFA session expired. Sign in again.');
    }
    if (payload.typ !== 'mfa') throw new UnauthorizedException('Invalid MFA token.');

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
    });
    if (!user) throw new UnauthorizedException('Invalid MFA token.');

    if (payload.method === 'TOTP') {
      if (!user.mfaSecret) throw new BadRequestException('TOTP not provisioned.');
      const valid = authenticator.verify({ token: code, secret: user.mfaSecret });
      if (!valid) throw new UnauthorizedException('Incorrect code.');
      if (!user.mfaEnrolledAt) {
        await this.prisma.user.update({
          where: { id: user.id },
          data: { mfaEnrolledAt: new Date() }, // first valid code confirms enrollment
        });
      }
    } else {
      const valid = await this.emailOtp.verify(user.id, code);
      if (!valid) throw new UnauthorizedException('Incorrect code.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    return this.issueTokens(user.id);
  }

  // ─────────────────────────── tokens ────────────────────────────────
  private async issueTokens(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException();

    const accessToken = await this.jwt.signAsync(
      {
        sub: user.id,
        employeeId: user.employeeId,
        roles: user.roles,
        typ: 'access',
      },
      { expiresIn: ACCESS_TTL },
    );

    // Opaque refresh token: "<id>.<secret>"; store only the secret's hash.
    const secret = randomBytes(32).toString('hex');
    const row = await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: await hash(secret),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
      },
    });
    return {
      accessToken,
      refreshToken: `${row.id}.${secret}`,
      tokenType: 'Bearer',
      expiresIn: 28800, // matches ACCESS_TTL (8h dev)
    };
  }

  async refresh(rawToken: string) {
    const [id, secret] = (rawToken ?? '').split('.');
    if (!id || !secret) throw new UnauthorizedException('Malformed refresh token.');

    const row = await this.prisma.refreshToken.findUnique({ where: { id } });
    if (!row || row.revokedAt || row.expiresAt < new Date())
      throw new UnauthorizedException('Refresh token invalid or expired.');

    const ok = await verify(row.tokenHash, secret).catch(() => false);
    if (!ok) {
      // Reuse/tamper signal — revoke the whole family for that user.
      await this.prisma.refreshToken.updateMany({
        where: { userId: row.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      throw new UnauthorizedException('Refresh token rejected.');
    }

    // Rotate: revoke the used token, issue a fresh pair.
    await this.prisma.refreshToken.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
    return this.issueTokens(row.userId);
  }

  async logout(rawToken: string) {
    const [id] = (rawToken ?? '').split('.');
    if (id) {
      await this.prisma.refreshToken
        .update({ where: { id }, data: { revokedAt: new Date() } })
        .catch(() => void 0);
    }
    return { ok: true };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: {
        employee: {
          include: { team: { select: { id: true, name: true, photoUrl: true } } },
        },
      },
    });
    if (!user) throw new UnauthorizedException();
    const { passwordHash, mfaSecret, ...safe } = user as any;
    return safe;
  }
}
