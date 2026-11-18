import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

const VALID_GST_RATES = [0, 5, 12, 18, 28] as const;

export class CreateProductDto {
  @IsString()
  @Matches(/^[0-9]{8,14}$/, { message: 'ean must be an 8 to 14 digit barcode' })
  ean: string;

  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @IsString()
  @MinLength(1)
  @MaxLength(120)
  brand: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  packSize: string;

  @IsString()
  @MinLength(2)
  @MaxLength(80)
  category: string;

  @IsNumber()
  @Min(0.01)
  mrp: number;

  @IsNumber()
  @IsIn(VALID_GST_RATES)
  gstRate: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  shelfLifeDays?: number;
}

export class UpdateProductDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  brand?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  packSize?: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(80)
  category?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.01)
  mrp?: number;

  @IsOptional()
  @IsNumber()
  @IsIn(VALID_GST_RATES)
  gstRate?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  shelfLifeDays?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class MergeProductsDto {
  @IsUUID()
  sourceId: string;

  @IsUUID()
  targetId: string;
}
