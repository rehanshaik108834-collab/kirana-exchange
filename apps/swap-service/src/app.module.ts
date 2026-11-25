import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OutboxRelayWorker,
  ProblemDetailsFilter,
  RabbitConsumerWorker,
  RateLimiterService,
  REDIS_CLIENT,
} from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { RiskListingDraft } from './entities/risk-listing-draft.entity';
import { ShopGeoReadModel } from './entities/shop-geo.entity';
import { ShortageRequest } from './entities/shortage-request.entity';
import { SwapListing } from './entities/swap-listing.entity';
import { SwapOffer } from './entities/swap-offer.entity';
import { GeoService } from './geo.service';
import { HealthController } from './health.controller';
import { InitSwapSchema1700000000000 } from './migrations/1700000000000-InitSwapSchema';
import { SwapEventConsumer } from './swap.consumer';
import { SwapController } from './swap.controller';
import { SwapService } from './swap.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'swap_db',
      entities: [
        SwapListing,
        ShortageRequest,
        SwapOffer,
        ShopGeoReadModel,
        RiskListingDraft,
        OutboxEvent,
      ],
      migrations: [InitSwapSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([
      SwapListing,
      ShortageRequest,
      SwapOffer,
      ShopGeoReadModel,
      RiskListingDraft,
      OutboxEvent,
    ]),
  ],
  controllers: [HealthController, SwapController],
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
    GeoService,
    SwapService,
    SwapEventConsumer,
    {
      provide: OutboxRelayWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.OUTBOX_RELAY_ENABLED === 'false'
          ? null
          : new OutboxRelayWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'swap-service',
            }),
    },
    {
      provide: RabbitConsumerWorker,
      inject: [DataSource, SwapEventConsumer],
      useFactory: (dataSource: DataSource, consumer: SwapEventConsumer) =>
        process.env.RABBIT_CONSUMER_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'swap-service',
              subscriptions: [consumer.getSubscription()],
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
    await this.redis.quit().catch(() => undefined);
  }
}
