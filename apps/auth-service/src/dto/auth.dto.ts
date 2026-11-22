import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import type { UserRole } from '../entities/user.entity';

export class RegisterDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(8)
  password: string;

  /**
   * Self-registration may only create shop users. Admins are created with
   * `pnpm --filter @kirana/auth-service create-admin` (DB access required), and a shopId is
   * linked only when the user's shop is created (shop.created.v1 consumer).
   */
  @IsOptional()
  @IsIn(['shop_owner', 'shop_staff'])
  role?: Exclude<UserRole, 'admin'>;
}

export class LoginDto {
  @IsOptional()
  @IsString()
  phone?: string;

  @IsOptional()
  @IsEmail()
  email?: string;

  @IsString()
  @MinLength(1)
  password: string;
}

export class RefreshTokenDto {
  @IsString()
  @MinLength(16)
  refreshToken: string;
}

export class LogoutDto {
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
