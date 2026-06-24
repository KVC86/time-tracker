import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { EmailOtpService } from './email-otp.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RolesGuard } from './roles.guard';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET ?? 'dev-secret',
      // per-token expiry is set at sign time (access 15m, mfa 5m)
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, EmailOtpService, JwtAuthGuard, RolesGuard],
  // Export guards + JwtModule so other modules (time-tracking, gateway)
  // can apply @UseGuards(JwtAuthGuard) and inject JwtService.
  exports: [JwtModule, JwtAuthGuard, RolesGuard],
})
export class AuthModule {}
