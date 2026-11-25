import { IsBoolean, IsEmail, IsOptional } from 'class-validator';

export class UpdateNotificationPreferencesDto {
  @IsEmail()
  email: string;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;
}
