import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsISO8601,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class PriceTierDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  minQty: number;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  unitPrice: number;
}

export class ProductTierScheduleDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  baseUnitPrice: number;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => PriceTierDto)
  tiers: PriceTierDto[];
}

export class CreateGroupBuyWindowDto {
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  distributorId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  state: string;

  @IsISO8601()
  cutoffAt: string;

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  minOrderValue: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  deliveryFee?: number;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ProductTierScheduleDto)
  priceTiers: ProductTierScheduleDto[];
}

export class UpsertCommitmentDto {
  @IsUUID()
  productId: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  qty: number;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  shopState?: string;
}

export class ListWindowsQueryDto {
  @IsOptional()
  @IsString()
  state?: string;

  @IsOptional()
  @IsString()
  status?: string;
}

export class CloseWindowDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  extensionHours?: number;
}
