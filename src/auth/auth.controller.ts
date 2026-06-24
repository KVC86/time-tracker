import {
  Controller,
  Post,
  Get,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  /** Step 1 — password. Returns an MFA challenge, never a session yet. */
  @Post('login')
  login(@Body() body: { identifier: string; password: string }) {
    return this.auth.login(body.identifier, body.password);
  }

  /** Step 2 — the second factor (TOTP code or emailed OTP). Returns tokens. */
  @Post('mfa/verify')
  verify(@Body() body: { mfaToken: string; code: string }) {
    return this.auth.verifyMfa(body.mfaToken, body.code);
  }

  @Post('refresh')
  refresh(@Body() body: { refreshToken: string }) {
    return this.auth.refresh(body.refreshToken);
  }

  @Post('logout')
  logout(@Body() body: { refreshToken: string }) {
    return this.auth.logout(body.refreshToken);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@Req() req: any) {
    return this.auth.me(req.user.userId);
  }
}
