import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { Role } from '@prisma/client';

export class CreateUserDto {
  @IsEnum(Role) role: Role;
  @IsString() fullName: string;
  @IsEmail() email: string;
  @IsString() @MinLength(8) password: string;
}
