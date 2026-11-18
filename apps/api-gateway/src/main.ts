import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import pino from 'pino';
import { AppModule } from './app.module';

const logger = pino({ name: 'api-gateway' });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableCors({
    origin: process.env.CORS_ORIGIN || 'http://localhost:5173',
    exposedHeaders: ['X-Correlation-Id', 'Retry-After', 'X-RateLimit-Remaining'],
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = Number(process.env.PORT || 3001);
  await app.listen(port);
  logger.info({ port, correlationId: 'startup' }, 'api-gateway listening');
}

bootstrap();
