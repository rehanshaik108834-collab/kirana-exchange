import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  ProblemDetailsFilter,
  RabbitConsumerWorker,
  RateLimiterService,
  REDIS_CLIENT,
} from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { RefreshToken } from './entities/refresh-token.entity';
import { User } from './entities/user.entity';
import { InitAuthSchema1700000000000 } from './migrations/1700000000000-InitAuthSchema';
import { AddProcessedMessages1700000000001 } from './migrations/1700000000001-AddProcessedMessages';
import { shopLinkingSubscription } from './shop-linking.consumer';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'auth_db',
      entities: [User, RefreshToken],
      migrations: [InitAuthSchema1700000000000, AddProcessedMessages1700000000001],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([User, RefreshToken]),
    JwtModule.register({
      secret: process.env.JWT_SECRET || 'dev-kirana-jwt-secret-change-in-prod',
      signOptions: { expiresIn: '15m' },
    }),
  ],
  controllers: [AuthController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
        }),
    },
    RateLimiterService,
    AuthService,
    {
      // shop.created.v1 -> users.shop_id. Set EVENT_CONSUMERS_ENABLED=false to disable.
      provide: RabbitConsumerWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.EVENT_CONSUMERS_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'auth-service',
              subscriptions: [shopLinkingSubscription],
            }),
    },
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule implements OnApplicationShutdown {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onApplicationShutdown() {
    await this.redis.quit();
  }
}
