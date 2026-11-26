import {
  Inject,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnApplicationShutdown,
} from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ProblemDetailsFilter, RateLimiterService, REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { GlobalIpRateLimitGuard } from './guards/rate-limit.guard';
import { HealthController } from './health.controller';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { SecurityHeadersMiddleware } from './middleware/security-headers.middleware';
import { GatewayProxyController } from './proxy.controller';
import { UpstreamClientService } from './resilience/upstream-client.service';

@Module({
  imports: [
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'dev-kirana-jwt-secret-change-in-prod',
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [HealthController, GatewayProxyController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
          lazyConnect: true,
          maxRetriesPerRequest: 1,
        }),
    },
    RateLimiterService,
    JwtAuthGuard,
    UpstreamClientService,
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
    {
      provide: APP_GUARD,
      useClass: GlobalIpRateLimitGuard,
    },
  ],
})
export class AppModule implements NestModule, OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationIdMiddleware, SecurityHeadersMiddleware).forRoutes('*');
  }

  async onApplicationShutdown() {
    await this.redis.quit().catch(() => undefined);
  }
}
