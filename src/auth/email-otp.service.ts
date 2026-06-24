// =====================================================================
//  EmailOtpService — the floor-agent second factor.
//
//  Generates a 6-digit code, stores only its hash with a short TTL, and
//  "sends" it. In DEV it logs the code to the server console so you can
//  test without a mail server. In PROD, swap `deliver()` for a real
//  transport (e.g. nodemailer / SES) — that's the only change needed.
// =====================================================================

import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';
import { PrismaService } from '../prisma/prisma.service';

const OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_ATTEMPTS = 5;

@Injectable()
export class EmailOtpService {
  private readonly log = new Logger('EmailOTP');

  constructor(private readonly prisma: PrismaService) {}

  /** Create + deliver a fresh code. Invalidates any prior unconsumed codes. */
  async issue(userId: string, email: string) {
    await this.prisma.emailOtp.updateMany({
      where: { userId, consumedAt: null },
      data: { consumedAt: new Date() }, // burn older codes
    });

    const code = String(Math.floor(100000 + Math.random() * 900000));
    await this.prisma.emailOtp.create({
      data: {
        userId,
        codeHash: await hash(code),
        expiresAt: new Date(Date.now() + OTP_TTL_MS),
      },
    });
    await this.deliver(email, code);
  }

  /** Verify the latest live code. Returns true once; consumes it. */
  async verify(userId: string, code: string): Promise<boolean> {
    const otp = await this.prisma.emailOtp.findFirst({
      where: { userId, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
    });
    if (!otp) throw new BadRequestException('Code expired or not found. Request a new one.');
    if (otp.attempts >= MAX_ATTEMPTS) {
      await this.prisma.emailOtp.update({
        where: { id: otp.id },
        data: { consumedAt: new Date() },
      });
      throw new BadRequestException('Too many attempts. Request a new code.');
    }

    const ok = await verify(otp.codeHash, code).catch(() => false);
    await this.prisma.emailOtp.update({
      where: { id: otp.id },
      data: ok ? { consumedAt: new Date() } : { attempts: { increment: 1 } },
    });
    return ok;
  }

  // ── swap this for a real mail transport in production ──
  private async deliver(email: string, code: string) {
    this.log.warn(`[DEV] Email OTP for ${email}: ${code}  (expires in 10 min)`);
  }
}
