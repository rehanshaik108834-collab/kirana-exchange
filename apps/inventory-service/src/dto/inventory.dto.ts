import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
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

export class AddStockBatchDto {
  @IsUUID()
  shopId: string;

  @IsUUID()
  productId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  batchCode: string;

  @IsInt()
  @Min(0)
  qty: number;

  @IsNumber()
  @Min(0)
  costPrice: number;

  @IsDateString()
  expiryDate: string;
}

export class RecordSaleDto {
  @IsUUID()
  shopId: string;

  @IsUUID()
  batchId: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsInt()
  @Min(1)
  expectedVersion: number;
}

export class ReserveStockDto {
  @IsUUID()
  shopId: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsInt()
  @Min(1)
  version: number;

  @IsOptional()
  @IsUUID()
  transactionId?: string;
}

export class ReleaseStockDto {
  @IsUUID()
  shopId: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsOptional()
  @IsUUID()
  transactionId?: string;
}

export class BulkImportBatchRowDto {
  @IsUUID()
  productId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(64)
  batchCode: string;

  @IsInt()
  @Min(0)
  qty: number;

  @IsNumber()
  @Min(0)
  costPrice: number;

  @IsDateString()
  expiryDate: string;

  @IsOptional()
  @IsUUID()
  idempotencyKey?: string;
}

export class BulkImportBatchesDto {
  @IsUUID()
  shopId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  @ValidateNested({ each: true })
  @Type(() => BulkImportBatchRowDto)
  rows: BulkImportBatchRowDto[];
}
