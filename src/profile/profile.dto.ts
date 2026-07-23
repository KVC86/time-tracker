import { IsString } from 'class-validator';

export class ProfilePhotoDto {
  @IsString() photo: string;
}
