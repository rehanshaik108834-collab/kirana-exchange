import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RateLimiterService, REDIS_CLIENT } from '@kirana/common';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'crypto';
import Redis from 'ioredis';
import pino from 'pino';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { RefreshToken } from './entities/refresh-token.entity';
import { User, UserRole } from './entities/user.entity';

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

type RotateTxOutcome =
  | { status: 'invalid' }
  | { status: 'expired'; familyId: string }
  | { status: 'reuse_detected'; familyId: string; userId: string }
  | {
      status: 'rotated';
      userId: string;
      role: UserRole;
      shopId: string | null;
      newPlainTextToken: string;
    };

const REFRESH_TOKEN_TTL_DAYS = 7;
const LOGIN_LOCKOUT_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_WINDOW_SECONDS = 15 * 60;

@Injectable()
export class AuthService {
  private readonly logger = pino({ name: 'auth-service' });

  constructor(
    private readonly dataSource: DataSource,
    private readonly jwtService: JwtService,
    private readonly rateLimiter: RateLimiterService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private hashToken(plainTextToken: string): string {
    return createHash('sha256').update(plainTextToken).digest('hex');
  }

  private generatePlainTextRefreshToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private async signAccessToken(
    userId: string,
    role: UserRole,
    shopId: string | null,
  ): Promise<string> {
    return this.jwtService.signAsync({
      sub: userId,
      jti: uuidv4(),
      role,
      shopId,
    });
  }

  async register(
    dto: RegisterDto,
    correlationId = 'unknown',
  ): Promise<AuthTokens & { userId: string; role: UserRole }> {
    if (!dto.phone && !dto.email) {
      throw new BadRequestException('Either phone or email is required');
    }

    const passwordHash = await argon2.hash(dto.password, { type: argon2.argon2id });
    const role: UserRole = dto.role ?? 'shop_owner';
    const plainTextRefresh = this.generatePlainTextRefreshToken();
    const tokenHash = this.hashToken(plainTextRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    let savedUser: User;
    try {
      savedUser = await this.dataSource.transaction(async (manager) => {
        const user = manager.create(User, {
          phone: dto.phone ?? null,
          email: dto.email ?? null,
          passwordHash,
          role,
          shopId: null,
          failedAttempts: 0,
          lockedUntil: null,
        });
        const persistedUser = await manager.save(User, user);

        const refreshRow = manager.create(RefreshToken, {
          userId: persistedUser.id,
          familyId: uuidv4(),
          tokenHash,
          replacedById: null,
          revoked: false,
          expiresAt,
        });
        await manager.save(RefreshToken, refreshRow);

        return persistedUser;
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new ConflictException('An account with this phone or email already exists');
      }
      throw err;
    }

    const accessToken = await this.signAccessToken(savedUser.id, savedUser.role, savedUser.shopId);
    this.logger.info(
      { correlationId, userId: savedUser.id, role: savedUser.role },
      'User registered',
    );

    return {
      userId: savedUser.id,
      role: savedUser.role,
      accessToken,
      refreshToken: plainTextRefresh,
    };
  }

  async login(
    dto: LoginDto,
    ip: string,
    correlationId = 'unknown',
  ): Promise<AuthTokens & { userId: string; role: UserRole; retryAfterSeconds?: number }> {
    const identifier = dto.email ?? dto.phone;
    if (!identifier) {
      throw new BadRequestException('Either phone or email is required');
    }

    const lockoutKey = `auth:lockout:${identifier}:${ip}`;
    const userRepo = this.dataSource.getRepository(User);
    const user = await userRepo.findOne({
      where: dto.email ? { email: dto.email } : { phone: dto.phone },
    });

    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000),
      );
      throw new HttpException(
        {
          message: 'Account temporarily locked due to repeated failed login attempts',
          error: 'Too Many Requests',
          retryAfterSeconds,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const passwordValid = user ? await argon2.verify(user.passwordHash, dto.password) : false;

    if (!user || !passwordValid) {
      const windowResult = await this.rateLimiter.consumeSlidingWindow(
        lockoutKey,
        LOGIN_LOCKOUT_MAX_ATTEMPTS,
        LOGIN_LOCKOUT_WINDOW_SECONDS,
      );

      if (user) {
        const nextAttempts = user.failedAttempts + 1;
        const shouldLock = nextAttempts >= LOGIN_LOCKOUT_MAX_ATTEMPTS;
        await userRepo.update(
          { id: user.id },
          {
            failedAttempts: nextAttempts,
            lockedUntil: shouldLock
              ? new Date(Date.now() + LOGIN_LOCKOUT_WINDOW_SECONDS * 1000)
              : null,
          },
        );
      }

      if (!windowResult.allowed) {
        this.logger.warn({ correlationId, ip }, 'Login brute-force lockout triggered');
        throw new HttpException(
          {
            message: 'Too many failed login attempts. Try again later.',
            error: 'Too Many Requests',
            retryAfterSeconds: windowResult.retryAfterSeconds,
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      throw new UnauthorizedException('Invalid credentials');
    }

    await this.rateLimiter.resetKey(lockoutKey);

    const plainTextRefresh = this.generatePlainTextRefreshToken();
    const tokenHash = this.hashToken(plainTextRefresh);
    const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

    await this.dataSource.transaction(async (manager) => {
      await manager.update(User, { id: user.id }, { failedAttempts: 0, lockedUntil: null });
      const refreshRow = manager.create(RefreshToken, {
        userId: user.id,
        familyId: uuidv4(),
        tokenHash,
        replacedById: null,
        revoked: false,
        expiresAt,
      });
      await manager.save(RefreshToken, refreshRow);
    });

    const accessToken = await this.signAccessToken(user.id, user.role, user.shopId);
    this.logger.info({ correlationId, userId: user.id }, 'User logged in');

    return {
      userId: user.id,
      role: user.role,
      accessToken,
      refreshToken: plainTextRefresh,
    };
  }

  /**
   * Refreshes a JWT session using rotating refresh tokens.
   * INVARIANT: Executed inside a PostgreSQL SERIALIZABLE transaction with a row lock.
   * 1. Hash the incoming plaintext token to find it in `refresh_tokens`.
   * 2. REUSE DETECTION: If `token.revoked === true` OR `token.replacedById !== null`,
   *    an attacker (or stale client) replayed a used token.
   *    -> UPDATE refresh_tokens SET revoked = true WHERE family_id = token.family_id.
   *    -> COMMIT the revocation first, THEN throw UnauthorizedException so the UPDATE is never rolled back.
   * 3. If valid and unexpired:
   *    -> Generate a new plaintext token and SHA-256 hash.
   *    -> Insert the new token with the same family_id.
   *    -> Update the old token: replaced_by_id = new_token.id, revoked = true.
   * 4. Return new access and refresh tokens.
   */
  async rotateRefreshToken(plainTextToken: string, correlationId = 'unknown'): Promise<AuthTokens> {
    const tokenHash = this.hashToken(plainTextToken);

    const outcome: RotateTxOutcome = await this.dataSource.transaction(
      'SERIALIZABLE',
      async (manager) => {
        const token = await manager.findOne(RefreshToken, {
          where: { tokenHash },
          lock: { mode: 'pessimistic_write' },
        });

        if (!token) {
          return { status: 'invalid' };
        }

        // REUSE DETECTION: revoke the entire session family and commit before throwing
        if (token.revoked || token.replacedById !== null) {
          await manager.update(RefreshToken, { familyId: token.familyId }, { revoked: true });
          return { status: 'reuse_detected', familyId: token.familyId, userId: token.userId };
        }

        if (token.expiresAt <= new Date()) {
          await manager.update(RefreshToken, { id: token.id }, { revoked: true });
          return { status: 'expired', familyId: token.familyId };
        }

        const user = await manager.findOne(User, { where: { id: token.userId } });
        if (!user) {
          return { status: 'invalid' };
        }

        const newPlainTextToken = this.generatePlainTextRefreshToken();
        const newTokenHash = this.hashToken(newPlainTextToken);
        const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

        const newToken = manager.create(RefreshToken, {
          userId: token.userId,
          familyId: token.familyId,
          tokenHash: newTokenHash,
          replacedById: null,
          revoked: false,
          expiresAt,
        });
        const savedNewToken = await manager.save(RefreshToken, newToken);

        await manager.update(
          RefreshToken,
          { id: token.id },
          {
            revoked: true,
            replacedById: savedNewToken.id,
          },
        );

        return {
          status: 'rotated',
          userId: user.id,
          role: user.role,
          shopId: user.shopId,
          newPlainTextToken,
        };
      },
    );

    if (outcome.status === 'reuse_detected') {
      this.logger.warn(
        { correlationId, familyId: outcome.familyId, userId: outcome.userId },
        'Refresh token replay detected; entire session family revoked',
      );
      throw new UnauthorizedException('Refresh token reuse detected; session family revoked');
    }

    if (outcome.status === 'expired') {
      throw new UnauthorizedException('Refresh token expired');
    }

    if (outcome.status === 'invalid') {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const accessToken = await this.signAccessToken(outcome.userId, outcome.role, outcome.shopId);

    return {
      accessToken,
      refreshToken: outcome.newPlainTextToken,
    };
  }

  async logout(
    accessToken: string | undefined,
    plainTextRefreshToken: string | undefined,
    correlationId = 'unknown',
  ): Promise<void> {
    if (accessToken) {
      try {
        const payload = await this.jwtService.verifyAsync<{ jti?: string; exp?: number }>(
          accessToken,
        );
        if (payload.jti && payload.exp) {
          const ttlSeconds = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
          await this.redis.set(`auth:denylist:${payload.jti}`, '1', 'EX', ttlSeconds);
        }
      } catch {
        // Already expired or invalid access token — nothing to denylist
      }
    }

    if (plainTextRefreshToken) {
      const tokenHash = this.hashToken(plainTextRefreshToken);
      await this.dataSource.transaction(async (manager) => {
        const token = await manager.findOne(RefreshToken, { where: { tokenHash } });
        if (token) {
          await manager.update(RefreshToken, { familyId: token.familyId }, { revoked: true });
        }
      });
    }

    this.logger.info({ correlationId }, 'Session logged out');
  }
}
