import { Type } from 'class-transformer';
import {
  IsDateString,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class CreateListingDto {
  @IsUUID()
  batchId: string;

  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  costPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price?: number;

  @IsDateString()
  batchExpiryDate: string;

  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  daysOfCover?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(336)
  ttlHours?: number;
}

export class CreateShortageDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  reorderQty: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  maxUnitPrice?: number;

  @IsOptional()
  @IsString()
  state?: string;
}

export class CandidateSearchQueryDto {
  @IsOptional()
  @IsUUID()
  productId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0.1)
  @Max(25)
  radiusKm?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class CreateOfferDto {
  @IsUUID()
  listingId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  offeredPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(72)
  ttlHours?: number;
}

export class CounterOfferDto {
  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  offeredPrice: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty?: number;
}
