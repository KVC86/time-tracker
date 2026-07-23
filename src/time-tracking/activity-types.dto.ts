import { IsString } from 'class-validator';

export class CreateActivityTypeDto {
  @IsString() name: string;
}
