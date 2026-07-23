import { IsOptional, IsString } from 'class-validator';

export class AssignActivityDto {
  @IsString() activityTypeId: string;
  @IsOptional() @IsString() employeeId?: string;
  @IsOptional() @IsString() teamId?: string;
}
