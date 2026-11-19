import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProblemDetailsFilter, REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import { InventoryBatch } from './entities/inventory-batch.entity';
import { OutboxEvent } from './entities/outbox-event.entity';
import { SaleEvent } from './entities/sale-event.entity';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';
import { InitInventorySchema1700000000000 } from './migrations/1700000000000-InitInventorySchema';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'inventory_db',
      entities: [InventoryBatch, SaleEvent, OutboxEvent],
      migrations: [InitInventorySchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([InventoryBatch, SaleEvent, OutboxEvent]),
  ],
  controllers: [InventoryController],
  providers: [
    {
      provide: REDIS_CLIENT,
      useFactory: () =>
        new Redis({
          host: process.env.REDIS_HOST || '127.0.0.1',
          port: Number(process.env.REDIS_PORT || 6379),
        }),
    },
    InventoryService,
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
