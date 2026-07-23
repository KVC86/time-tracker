import {
  IsArray,
  IsBoolean,
  IsNumber,
  IsOptional,
  IsString,
} from 'class-validator';

export class ApplyScheduleDto {
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) employeeIds?: string[];
  @IsOptional() @IsString() teamId?: string;
  @IsString() startDate: string; // YYYY-MM-DD
  @IsString() endDate: string; // YYYY-MM-DD
  @IsOptional() @IsString() startTime?: string; // HH:mm
  @IsOptional() @IsString() endTime?: string; // HH:mm
  @IsOptional() @IsBoolean() isNightShift?: boolean;
  @IsOptional() @IsArray() @IsString({ each: true }) restDays?: string[];
  @IsOptional() @IsBoolean() force?: boolean;
}

export class CopyScheduleDto {
  @IsString() sourceStart: string;
  @IsString() destStart: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsBoolean() force?: boolean;
}

export class ManualShiftDto {
  @IsString() employeeId: string;
  @IsString() date: string;
  @IsString() startTime: string;
  @IsNumber() hours: number;
}
