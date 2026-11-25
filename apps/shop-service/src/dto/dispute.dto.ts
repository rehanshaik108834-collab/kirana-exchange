import { Type } from 'class-transformer';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

export class CreateDisputeDto {
  @IsUUID()
  transactionId: string;

  @IsUUID()
  accusedShopId: string;

  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason: string;
}

export class ResolveDisputeDto {
  @IsIn(['RESOLVED', 'DISMISSED'])
  status: 'RESOLVED' | 'DISMISSED';

  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  resolutionNotes: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(25)
  penaltyPoints?: number;
}
