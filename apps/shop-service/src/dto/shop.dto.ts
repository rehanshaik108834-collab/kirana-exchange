import {
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type { GstScheme } from '../entities/shop.entity';

export class CreateShopDto {
  @IsUUID()
  ownerId: string;

  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name: string;

  @IsString()
  @MinLength(5)
  address: string;

  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  state: string;

  @IsIn(['REGULAR', 'COMPOSITION', 'UNREGISTERED'])
  gstScheme: GstScheme;

  @IsOptional()
  @IsObject()
  operatingHours?: Record<string, any>;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  swapRadiusKm?: number;
}

export class UpdateShopLocationDto {
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat: number;

  @IsNumber()
  @Min(-180)
  @Max(180)
  lng: number;

  @IsString()
  @MinLength(2)
  @MaxLength(64)
  state: string;

  @IsOptional()
  @IsString()
  @MinLength(5)
  address?: string;

  @IsOptional()
  @IsNumber()
  @Min(0.1)
  @Max(10)
  swapRadiusKm?: number;
}
