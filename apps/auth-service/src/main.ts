import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pino from 'pino';
import { AppModule } from './app.module';

const logger = pino({ name: 'auth-service' });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT || 3002);
  await app.listen(port);
  logger.info({ port, correlationId: 'startup' }, 'auth-service listening');
}

bootstrap();
