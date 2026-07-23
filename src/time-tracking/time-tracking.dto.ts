import { IsEnum, IsOptional, IsString } from 'class-validator';
import { BreakType } from '@prisma/client';

export class ClockInDto {
  @IsString() activityType: string;
  @IsOptional() @IsString() source?: string;
}

export class SwitchActivityDto {
  @IsString() activityType: string;
}

export class StartBreakDto {
  @IsEnum(BreakType) breakType: BreakType;
}

export class GrantOvertimeDto {
  @IsString() employeeId: string;
}
