import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxRelayWorker, ProblemDetailsFilter } from '@kirana/common';
import { DataSource } from 'typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { Shop } from './entities/shop.entity';
import { InitShopSchema1700000000000 } from './migrations/1700000000000-InitShopSchema';
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
      entities: [Shop, OutboxEvent],
      migrations: [InitShopSchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([Shop, OutboxEvent]),
  ],
  controllers: [ShopController],
  providers: [
    {
      // Slice 3b: drains outbox_events into kirana.events (ADR-003). Set OUTBOX_RELAY_ENABLED=false to disable.
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
    {
      provide: APP_FILTER,
      useClass: ProblemDetailsFilter,
    },
  ],
})
export class AppModule {}
