import { IsString } from 'class-validator';

export class LoginDto {
  @IsString() identifier: string;
  @IsString() password: string;
}

export class VerifyMfaDto {
  @IsString() mfaToken: string;
  @IsString() code: string;
}

export class RefreshTokenDto {
  @IsString() refreshToken: string;
}
