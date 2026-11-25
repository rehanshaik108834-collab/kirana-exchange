import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxRelayWorker, ProblemDetailsFilter, REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { GroupBuyAllocation } from './entities/groupbuy-allocation.entity';
import { GroupBuyCommitment } from './entities/groupbuy-commitment.entity';
import { GroupBuyWindow } from './entities/groupbuy-window.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { GroupBuyController } from './groupbuy.controller';
import { GroupBuySchedulerWorker } from './groupbuy.scheduler';
import { GroupBuyService } from './groupbuy.service';
import { HealthController } from './health.controller';
import { InitGroupBuySchema1700000000000 } from './migrations/1700000000000-InitGroupBuySchema';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'groupbuy_db',
      entities: [GroupBuyWindow, GroupBuyCommitment, GroupBuyAllocation, OutboxEvent],
      migrations: [InitGroupBuySchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([GroupBuyWindow, GroupBuyCommitment, GroupBuyAllocation, OutboxEvent]),
  ],
  controllers: [HealthController, GroupBuyController],
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
    GroupBuyService,
    {
      provide: GroupBuySchedulerWorker,
      inject: [GroupBuyService],
      useFactory: (service: GroupBuyService) =>
        process.env.GROUPBUY_SCHEDULER_ENABLED === 'false'
          ? null
          : new GroupBuySchedulerWorker(service, Number(process.env.GROUPBUY_POLL_MS || 15_000)),
    },
    {
      provide: OutboxRelayWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.OUTBOX_RELAY_ENABLED === 'false'
          ? null
          : new OutboxRelayWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'groupbuy-service',
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
