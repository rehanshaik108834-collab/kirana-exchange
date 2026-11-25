import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProblemDetailsFilter, RabbitConsumerWorker, REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { SwapEvent } from './entities/swap-event.entity';
import { SwapTransaction } from './entities/swap-transaction.entity';
import { HealthController } from './health.controller';
import { InvoiceService } from './invoice.service';
import { InitSagaSchema1700000000000 } from './migrations/1700000000000-InitSagaSchema';
import { SagaOutboxWorker } from './saga-outbox.relay';
import { SagaEventConsumer } from './saga.consumer';
import { SagaController } from './saga.controller';
import { SagaService } from './saga.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'saga_db',
      entities: [SwapTransaction, SwapEvent, OutboxEvent],
      migrations: [InitSagaSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([SwapTransaction, SwapEvent, OutboxEvent]),
  ],
  controllers: [HealthController, SagaController],
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
    InvoiceService,
    SagaService,
    SagaEventConsumer,
    {
      provide: SagaOutboxWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.OUTBOX_RELAY_ENABLED === 'false'
          ? null
          : new SagaOutboxWorker(
              dataSource,
              process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
            ),
    },
    {
      provide: RabbitConsumerWorker,
      inject: [DataSource, SagaEventConsumer],
      useFactory: (dataSource: DataSource, consumer: SagaEventConsumer) =>
        process.env.RABBIT_CONSUMER_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'saga-orchestrator',
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
