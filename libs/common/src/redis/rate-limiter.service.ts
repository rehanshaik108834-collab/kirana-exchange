import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';

export const REDIS_CLIENT = Symbol.for('KIRANA_REDIS_CLIENT');

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

@Injectable()
export class RateLimiterService {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  /**
   * Atomic Token Bucket Lua script for bursty rate limits:
   * - Global IP limit: 100 req/min, burst capacity 30
   * - State-mutating per shop: 60 writes/min
   */
  private readonly TOKEN_BUCKET_SCRIPT = `
    local key = KEYS[1]
    local rate = tonumber(ARGV[1])
    local capacity = tonumber(ARGV[2])
    local now = tonumber(ARGV[3])
    local requested = tonumber(ARGV[4])

    local refill_per_sec = rate / 60
    local info = redis.call('HMGET', key, 'tokens', 'last_refreshed')
    local tokens = tonumber(info[1])
    local last_refreshed = tonumber(info[2])

    if not tokens or not last_refreshed then
      tokens = capacity
      last_refreshed = now
    end

    local time_passed = math.max(0, now - last_refreshed)
    tokens = math.min(capacity, tokens + (time_passed * refill_per_sec))

    local ttl = math.max(60, math.ceil((capacity / refill_per_sec) * 2))

    if tokens >= requested then
      tokens = tokens - requested
      redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refreshed', tostring(now))
      redis.call('EXPIRE', key, ttl)
      return { 1, math.floor(tokens), 0 }
    else
      local needed = requested - tokens
      local retry_after = math.ceil(needed / refill_per_sec)
      redis.call('HSET', key, 'tokens', tostring(tokens), 'last_refreshed', tostring(now))
      redis.call('EXPIRE', key, ttl)
      return { 0, math.floor(tokens), retry_after }
    end
  `;

  /**
   * Atomic Sliding Window Lua script for strict window limits:
   * - Auth failed logins: 5 attempts / 15 minutes (per Account + IP)
   * - Swap offers anti-spam: 20 offers / hour (per Shop)
   */
  private readonly SLIDING_WINDOW_SCRIPT = `
    local key = KEYS[1]
    local limit = tonumber(ARGV[1])
    local window_ms = tonumber(ARGV[2])
    local now_ms = tonumber(ARGV[3])
    local member = ARGV[4]

    local window_start = now_ms - window_ms
    redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

    local count = redis.call('ZCARD', key)
    if count < limit then
      redis.call('ZADD', key, now_ms, member)
      redis.call('PEXPIRE', key, window_ms)
      return { 1, limit - count - 1, 0 }
    else
      local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
      local oldest_ts = tonumber(oldest[2]) or now_ms
      local retry_ms = math.max(1000, (oldest_ts + window_ms) - now_ms)
      return { 0, 0, math.ceil(retry_ms / 1000) }
    end
  `;

  async consumeTokenBucket(
    key: string,
    ratePerMinute: number,
    capacity: number,
    requested = 1,
  ): Promise<RateLimitResult> {
    const nowSeconds = Date.now() / 1000;
    const [allowed, remaining, retryAfterSeconds] = (await this.redis.eval(
      this.TOKEN_BUCKET_SCRIPT,
      1,
      key,
      ratePerMinute,
      capacity,
      nowSeconds,
      requested,
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining: Number(remaining),
      retryAfterSeconds: Number(retryAfterSeconds),
    };
  }

  async checkLimit(ip: string, rate: number, capacity: number): Promise<boolean> {
    const result = await this.consumeTokenBucket(`rl:ip:${ip}`, rate, capacity);
    return result.allowed;
  }

  async consumeSlidingWindow(
    key: string,
    limit: number,
    windowSeconds: number,
  ): Promise<RateLimitResult> {
    const nowMs = Date.now();
    const windowMs = windowSeconds * 1000;
    const member = `${nowMs}:${randomUUID()}`;

    const [allowed, remaining, retryAfterSeconds] = (await this.redis.eval(
      this.SLIDING_WINDOW_SCRIPT,
      1,
      key,
      limit,
      windowMs,
      nowMs,
      member,
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      remaining: Number(remaining),
      retryAfterSeconds: Number(retryAfterSeconds),
    };
  }

  async resetKey(key: string): Promise<void> {
    await this.redis.del(key);
  }
}
