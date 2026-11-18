import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, LogoutDto, RefreshTokenDto, RegisterDto } from './dto/auth.dto';

@Controller('v1/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('health')
  health(@Headers('x-correlation-id') correlationId = 'unknown') {
    return { status: 'ok', service: 'auth-service', correlationId };
  }

  @Post('register')
  async register(@Body() dto: RegisterDto, @Headers('x-correlation-id') correlationId = 'unknown') {
    return this.authService.register(dto, correlationId);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    try {
      return await this.authService.login(dto, ip, correlationId);
    } catch (err) {
      if (err instanceof HttpException && err.getStatus() === HttpStatus.TOO_MANY_REQUESTS) {
        const body = err.getResponse() as { retryAfterSeconds?: number };
        if (body?.retryAfterSeconds) {
          res.setHeader('Retry-After', String(body.retryAfterSeconds));
        }
      }
      throw err;
    }
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() dto: RefreshTokenDto,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    return this.authService.rotateRefreshToken(dto.refreshToken, correlationId);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @Body() dto: LogoutDto,
    @Headers('authorization') authHeader?: string,
    @Headers('x-correlation-id') correlationId = 'unknown',
  ) {
    const accessToken = authHeader?.startsWith('Bearer ')
      ? authHeader.slice('Bearer '.length).trim()
      : undefined;
    await this.authService.logout(accessToken, dto.refreshToken, correlationId);
  }
}
