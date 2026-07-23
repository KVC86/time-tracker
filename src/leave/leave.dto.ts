import { IsArray, IsEnum, IsOptional, IsString } from 'class-validator';
import { LeaveType } from '@prisma/client';

export class SubmitLeaveDto {
  @IsEnum(LeaveType) leaveType: LeaveType;
  @IsString() startDate: string;
  @IsString() endDate: string;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) attachments?: string[];
}

export class LeaveDecisionDto {
  @IsOptional() @IsString() note?: string;
}
