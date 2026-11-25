import { IsOptional, IsString, Length, Matches, MaxLength } from 'class-validator';

export class ConfirmHandoverDto {
  @IsString()
  @Length(6, 6)
  @Matches(/^\d{6}$/, { message: 'handoverCode must be a 6-digit numeric PIN' })
  handoverCode: string;
}

export class CancelSagaDto {
  @IsOptional()
  @IsString()
  @MaxLength(32)
  reason?: string;
}
