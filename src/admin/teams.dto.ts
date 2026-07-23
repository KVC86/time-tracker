import { IsOptional, IsString } from 'class-validator';

export class CreateTeamDto {
  @IsString() name: string;
}

export class UpdateTeamDto {
  @IsOptional() @IsString() name?: string;
  // @IsOptional() also permits null, which clears the lead/manager.
  @IsOptional() @IsString() leadId?: string | null;
  @IsOptional() @IsString() managerId?: string | null;
}

export class TeamMemberDto {
  @IsString() employeeId: string;
}

export class TeamPhotoDto {
  @IsString() photo: string;
}
