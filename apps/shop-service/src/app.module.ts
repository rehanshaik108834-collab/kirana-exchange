import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxRelayWorker, ProblemDetailsFilter, RabbitConsumerWorker } from '@kirana/common';
import { DataSource } from 'typeorm';
import { DisputeController } from './dispute.controller';
import { DisputeService } from './dispute.service';
import { Dispute } from './entities/dispute.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { Shop } from './entities/shop.entity';
import { InitShopSchema1700000000000 } from './migrations/1700000000000-InitShopSchema';
import { ReputationEventConsumer } from './reputation.consumer';
import { ShopController } from './shop.controller';
import { ShopService } from './shop.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'shop_db',
      entities: [Shop, Dispute, OutboxEvent],
      migrations: [InitShopSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([Shop, Dispute, OutboxEvent]),
  ],
  // DisputeController is registered before ShopController so /v1/shops/disputes matches before :shopId
  controllers: [DisputeController, ShopController],
  providers: [
    {
      provide: OutboxRelayWorker,
      inject: [DataSource],
      useFactory: (dataSource: DataSource) =>
        process.env.OUTBOX_RELAY_ENABLED === 'false'
          ? null
          : new OutboxRelayWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'shop-service',
            }),
    },
    ShopService,
    DisputeService,
    ReputationEventConsumer,
    {
      provide: RabbitConsumerWorker,
      inject: [DataSource, ReputationEventConsumer],
      useFactory: (dataSource: DataSource, consumer: ReputationEventConsumer) =>
        process.env.RABBIT_CONSUMER_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'shop-service',
              subscriptions: [consumer.getSubscription()],
            }),
    },
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule {}
