import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import {
  OutboxRelayWorker,
  ProblemDetailsFilter,
  RabbitConsumerWorker,
  REDIS_CLIENT,
} from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { InventoryBatch } from './entities/inventory-batch.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { SagaStockOperation } from './entities/saga-stock-operation.entity';
import { SaleEvent } from './entities/sale-event.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InitInventorySchema1700000000000 } from './migrations/1700000000000-InitInventorySchema';
import { AddSagaStockOperations1700000000001 } from './migrations/1700000000001-AddSagaStockOperations';
import { SagaInventoryService } from './saga-inventory.service';
import { InventorySagaConsumer } from './saga.consumer';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'inventory_db',
      entities: [InventoryBatch, SaleEvent, OutboxEvent, SagaStockOperation],
      migrations: [InitInventorySchema1700000000000, AddSagaStockOperations1700000000001],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([InventoryBatch, SaleEvent, OutboxEvent, SagaStockOperation]),
  ],
  controllers: [InventoryController],
  providers: [
    {
      provide: OutboxRelayWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.OUTBOX_RELAY_ENABLED === 'false'
          ? null
          : new OutboxRelayWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'inventory-service',
            }),
    },
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
    InventoryService,
    SagaInventoryService,
    InventorySagaConsumer,
    {
      provide: RabbitConsumerWorker,
      inject: [DataSource, InventorySagaConsumer],
      useFactory: (dataSource: DataSource, consumer: InventorySagaConsumer) =>
        process.env.RABBIT_CONSUMER_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'inventory-service',
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
