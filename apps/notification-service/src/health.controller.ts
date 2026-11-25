import { Controller, Get, Inject, Optional } from '@nestjs/common';
import { REDIS_CLIENT } from '@kirana/common';
import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

@Controller('health')
export class HealthController {
  constructor(
    private readonly dataSource: DataSource,
    @Optional() @Inject(REDIS_CLIENT) private readonly redis?: Redis,
  ) {}

  @Get()
  async check() {
    let db = 'down';
    try {
      await this.dataSource.query('SELECT 1');
      db = 'up';
    } catch {
      db = 'down';
    }

    let redisStatus = 'down';
    if (this.redis) {
      try {
        const pong = await this.redis.ping();
        redisStatus = pong === 'PONG' ? 'up' : 'down';
      } catch {
        redisStatus = 'down';
      }
    }

    const status = db === 'down' ? 'unhealthy' : redisStatus === 'down' ? 'degraded' : 'ok';
    return { status, service: 'notification-service', database: db, redis: redisStatus };
  }
}
