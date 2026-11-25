import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pino from 'pino';
import { AppModule } from './app.module';

const logger = pino({ name: 'groupbuy-service' });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT || 3009);
  await app.listen(port);
  logger.info({ port, correlationId: 'startup' }, 'groupbuy-service listening');
}

bootstrap();
