import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ProblemDetailsFilter, RabbitConsumerWorker, REDIS_CLIENT } from '@kirana/common';
import Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { NotificationRecord } from './entities/notification.entity';
import { ShopContact } from './entities/shop-contact.entity';
import { HealthController } from './health.controller';
import { MailerService } from './mailer.service';
import { InitNotifySchema1700000000000 } from './migrations/1700000000000-InitNotifySchema';
import { NotificationEventConsumer } from './notification.consumer';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  imports: [
    TypeOrmModule.forRoot({
      type: 'postgres',
      host: process.env.DB_HOST || '127.0.0.1',
      port: Number(process.env.DB_PORT || 5432),
      username: process.env.DB_USER || 'kirana_admin',
      password: process.env.DB_PASSWORD || 'secretpassword',
      database: process.env.DB_NAME || 'notify_db',
      entities: [NotificationRecord, ShopContact],
      migrations: [InitNotifySchema1700000000000],
      migrationsRun: true,
      synchronize: false,
    }),
    TypeOrmModule.forFeature([NotificationRecord, ShopContact]),
  ],
  controllers: [HealthController, NotificationController],
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
    MailerService,
    NotificationService,
    NotificationEventConsumer,
    {
      provide: RabbitConsumerWorker,
      inject: [DataSource, NotificationEventConsumer],
      useFactory: (dataSource: DataSource, consumer: NotificationEventConsumer) =>
        process.env.RABBIT_CONSUMER_ENABLED === 'false'
          ? null
          : new RabbitConsumerWorker(dataSource, {
              amqpUrl: process.env.AMQP_URL || 'amqp://kirana_admin:secretpassword@127.0.0.1:5672',
              serviceName: 'notification-service',
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
