import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class IdleEventDto {
  @IsString() employeeCode: string;
  @IsIn(['idle_start', 'idle_end']) event: 'idle_start' | 'idle_end';
  @IsInt() @Min(0) idleMs: number;
  // agent-side UTC timestamp, audit-logged only — server time rules.
  @IsOptional() @IsString() ts?: string;
}
