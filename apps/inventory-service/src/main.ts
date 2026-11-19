import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import pino from 'pino';
import { AppModule } from './app.module';

const logger = pino({ name: 'inventory-service' });

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: false });
  app.useBodyParser('json', { limit: '10mb' });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT || 3005);
  await app.listen(port);
  logger.info({ port, correlationId: 'startup' }, 'inventory-service listening');
}

bootstrap();
